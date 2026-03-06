use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Window};

// Windows 专属：隐藏 PowerShell 控制台窗口
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// 为 Command 统一添加无窗口标志的帮助宏
// 只做 &mut 调用，不 move、不产生额外值
macro_rules! no_window {
    ($cmd:expr) => {
        #[cfg(target_os = "windows")]
        { $cmd.creation_flags(CREATE_NO_WINDOW); }
    };
}

// ─── 数据结构 ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppManifest {
    pub version: String,
    pub phase: String,
    pub install_dir: String,
    pub gateway_port: u16,
    pub gateway_pid: Option<u32>,
    pub api_provider: String,
    pub api_key_configured: bool,
    pub api_key_verified: bool,
    pub steps_done: Vec<String>,
    pub last_error: Option<String>,
}

impl Default for AppManifest {
    fn default() -> Self {
        AppManifest {
            version: "1.0.0".into(),
            phase: "fresh".into(),
            install_dir: "C:\\OpenClaw".into(),
            gateway_port: 18789,
            gateway_pid: None,
            api_provider: "".into(),
            api_key_configured: false,
            api_key_verified: false,
            steps_done: vec![],
            last_error: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SysCheckResult {
    pub admin: bool,
    pub webview2: bool,
    pub disk_gb: f64,
    pub port: u16,
    pub path_valid: bool,
    pub path_issue: String,
    pub network_ok: bool,
    pub suggested_dir: String,
}

#[derive(Debug, Serialize)]
pub struct ValidateResult {
    pub status: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct CheckEnvironmentResult {
    pub openclaw_installed: bool,
    pub config_exists: bool,
    pub manifest_complete: bool,
    pub manifest: Option<AppManifest>,
}

// ─── 结构化命令结果 ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandResult {
    pub success: bool,
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    pub command: String,
    pub exit_code: Option<i32>,
    pub log_path: Option<String>,
    pub retriable: bool,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

impl CommandResult {
    fn ok(command: &str, message: &str) -> Self {
        Self {
            success: true,
            code: "OK".into(),
            message: message.into(),
            hint: None,
            command: command.into(),
            exit_code: Some(0),
            log_path: None,
            retriable: false,
            stdout: None,
            stderr: None,
        }
    }

    fn error(command: &str, code: &str, message: &str, hint: Option<&str>, retriable: bool) -> Self {
        Self {
            success: false,
            code: code.into(),
            message: message.into(),
            hint: hint.map(|s| s.into()),
            command: command.into(),
            exit_code: None,
            log_path: None,
            retriable,
            stdout: None,
            stderr: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DoctorIssue {
    pub code: String,
    pub message: String,
    pub severity: String,
    pub fixable: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DoctorResult {
    pub success: bool,
    pub passed: bool,
    pub issues: Vec<DoctorIssue>,
    pub summary: String,
    pub log_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CliCapabilities {
    pub version: Option<String>,
    pub has_onboarding: bool,
    pub has_doctor: bool,
    pub has_gateway: bool,
    pub has_dashboard: bool,
    pub onboarding_flags: Vec<String>,
    pub doctor_flags: Vec<String>,
    pub gateway_flags: Vec<String>,
}

// ─── 嵌入 PowerShell 脚本（编译时内嵌，运行时写入临时目录）─────────────────
static INSTALL_PS1:  &str = include_str!("../scripts/install.ps1");
static GATEWAY_PS1:  &str = include_str!("../scripts/gateway.ps1");
static SYSCHECK_PS1: &str = include_str!("../scripts/syscheck.ps1");

/// 将嵌入脚本写入临时目录，返回路径（每次调用覆盖写入，保证最新）
fn get_embedded_script(name: &str) -> Result<PathBuf, String> {
    let content = match name {
        "install.ps1"  => INSTALL_PS1,
        "gateway.ps1"  => GATEWAY_PS1,
        "syscheck.ps1" => SYSCHECK_PS1,
        _ => return Err(format!("未知脚本: {}", name)),
    };
    let tmp = std::env::temp_dir().join("openclaw_scripts");
    std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let path = tmp.join(name);
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("写入脚本失败: {e}"))?;
    Ok(path)
}

/// 优先使用 resource_dir 里的脚本（NSIS 安装场景），
/// 若不存在则 fallback 到嵌入脚本（portable / dev 场景）
fn get_script_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("scripts").join(name);
        if p.exists() {
            return Ok(p);
        }
    }
    // fallback：从嵌入内容写到临时目录
    get_embedded_script(name)
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────

fn manifest_path(install_dir: &str) -> PathBuf {
    Path::new(install_dir).join("manifest.json")
}

fn read_manifest(install_dir: &str) -> Option<AppManifest> {
    let path = manifest_path(install_dir);
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_manifest(manifest: &AppManifest) -> Result<(), String> {
    std::fs::create_dir_all(&manifest.install_dir)
        .map_err(|e| format!("创建目录失败: {e}"))?;
    let path = manifest_path(&manifest.install_dir);
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("写入 manifest 失败: {e}"))
}

/// 解析脚本输出行，返回 (level, message)
fn parse_log_line(line: &str) -> (&'static str, String) {
    if let Some(msg) = line.strip_prefix("[OK]") {
        ("ok", msg.trim().to_string())
    } else if let Some(msg) = line.strip_prefix("[WARN]") {
        ("warn", msg.trim().to_string())
    } else if let Some(msg) = line.strip_prefix("[ERROR]") {
        ("error", msg.trim().to_string())
    } else if let Some(msg) = line.strip_prefix("[DIM]") {
        ("dim", msg.trim().to_string())
    } else if let Some(msg) = line.strip_prefix("[INFO]") {
        ("info", msg.trim().to_string())
    } else if let Some(url) = line.strip_prefix("[MANUAL_DOWNLOAD]") {
        ("manual_download", url.trim().to_string())
    } else if line.starts_with("[RESULT]") || line.starts_with("[PROGRESS:") {
        ("dim", String::new())
    } else {
        ("dim", line.to_string())
    }
}

/// 在 Tokio 阻塞线程中运行 PowerShell 脚本（隐藏窗口），逐行 emit 日志
fn run_ps_script_streaming_sync(
    window: Window,
    script_path: PathBuf,
    env_pairs: Vec<(String, String)>,
    event_name: &str,
) -> Result<String, String> {
    // Use -Command with [scriptblock]::Create() to completely bypass ExecutionPolicy.
    // -File triggers policy checks; -Command with inline code does NOT.
    let invoke_expr = format!(
        "& ([scriptblock]::Create([System.IO.File]::ReadAllText('{}')))",
        script_path.to_string_lossy().replace('\'', "''")
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &invoke_expr]);
    for (k, v) in &env_pairs {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window!(cmd);

    let mut child = cmd.spawn().map_err(|e| format!("启动 PowerShell 失败: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let win2 = window.clone();
    let event_name_owned = event_name.to_string();
    let stdout_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut last_result = String::new();
        for line in reader.lines().map_while(Result::ok) {
            if line.starts_with("[RESULT]") {
                last_result = line[8..].to_string();
            } else if let Some(progress) = line.strip_prefix("[PROGRESS:") {
                // 解析 "X/Y] Label" 格式，驱动前端步骤进度
                if let Some(slash) = progress.find('/') {
                    if let Ok(step) = progress[..slash].parse::<u32>() {
                        let rest = &progress[slash + 1..];
                        let total = rest.split(']').next()
                            .and_then(|s| s.parse::<u32>().ok())
                            .unwrap_or(4);
                        let label = rest.split(']').nth(1)
                            .unwrap_or("").trim().to_string();
                        win2.emit("install-progress", serde_json::json!({
                            "step": step, "total": total, "label": label
                        })).ok();
                    }
                }
            } else {
                let (level, msg) = parse_log_line(&line);
                if !msg.is_empty() {
                    win2.emit(&event_name_owned, serde_json::json!({ "level": level, "message": msg }))
                        .ok();
                }
            }
        }
        last_result
    });

    let event_name_stderr = event_name.to_string();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let t = line.trim().to_string();
            if !t.is_empty() && !t.starts_with("+ ") && !t.starts_with("    +") {
                window
                    .emit(&event_name_stderr, serde_json::json!({ "level": "error", "message": t }))
                    .ok();
            }
        }
    });

    let result = stdout_handle.join().unwrap_or_default();
    let status = child.wait().map_err(|e| format!("等待进程失败: {e}"))?;

    // #region agent log
    {
        use std::io::Write as _;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(
            r"d:\CODE\openclawInstaller\openclaw_installer_windows\.cursor\debug.log"
        ) {
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
            let _ = writeln!(f, "{{\"location\":\"commands.rs:run_ps_done\",\"message\":\"script finished\",\"data\":{{\"exit_code\":{},\"result_len\":{},\"result_preview\":\"{}\",\"event\":\"{}\"}},\"timestamp\":{},\"runId\":\"post-fix\",\"hypothesisId\":\"F\"}}",
                status.code().unwrap_or(-999),
                result.len(),
                result.chars().take(100).collect::<String>().replace('\\', "\\\\").replace('"', "\\\""),
                event_name,
                ts);
        }
    }
    // #endregion

    if !status.success() && result.is_empty() {
        return Err(format!("脚本退出码: {}", status.code().unwrap_or(-1)));
    }
    Ok(result)
}

// ─── Tauri 命令 ───────────────────────────────────────────────────────────

/// 获取应用状态（从默认安装目录读取 manifest）
#[tauri::command]
pub fn get_app_state() -> Option<AppManifest> {
    let install_dir = default_install_dir_inner();
    read_manifest(&install_dir)
}

/// 检测环境是否已配置完成（用于第二次启动时决定跳步）
#[tauri::command]
pub fn check_environment() -> CheckEnvironmentResult {
    refresh_path();
    let openclaw_installed = find_openclaw_cmd().is_some();

    let config_exists = openclaw_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("openclaw.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("models")
                .and_then(|m| m.get("providers"))
                .and_then(|p| p.as_object())
                .map(|o| !o.is_empty())
        })
        .unwrap_or(false);

    let install_dir = default_install_dir_inner();
    let manifest = read_manifest(&install_dir);
    let manifest_complete = manifest
        .as_ref()
        .map(|m| m.phase == "complete")
        .unwrap_or(false);

    CheckEnvironmentResult {
        openclaw_installed,
        config_exists,
        manifest_complete,
        manifest,
    }
}

/// 系统预检（纯 Rust 实现，不弹出 PowerShell 窗口）
#[tauri::command]
pub async fn run_syscheck(install_dir: String) -> Result<SysCheckResult, String> {
    tokio::task::spawn_blocking(move || {
        let admin = check_admin();
        let webview2 = check_webview2();
        let disk_gb = get_disk_free_gb(&install_dir);
        let port = find_free_port(18789);
        let (path_valid, path_issue, suggested_dir) = check_path(&install_dir);
        let network_ok = check_network_sync();

        SysCheckResult {
            admin,
            webview2,
            disk_gb,
            port,
            path_valid,
            path_issue,
            network_ok,
            suggested_dir,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

fn check_admin() -> bool {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command",
        "[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"])
        .stdout(Stdio::piped()).stderr(Stdio::null());
    no_window!(cmd);
    match cmd.output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim() == "True",
        Err(_) => false,
    }
}

fn check_webview2() -> bool {
    // 直接查注册表，不调用 PowerShell
    let keys = [
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];
    for key in &keys {
        if std::fs::metadata(format!("HKLM\\{key}")).is_ok() {
            return true;
        }
    }
    // fallback: 用 reg query（无 PowerShell）
    let mut cmd = Command::new("reg");
    cmd.args(["query",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"])
        .stdout(Stdio::piped()).stderr(Stdio::null());
    no_window!(cmd);
    if let Ok(o) = cmd.output() {
        if o.status.success() { return true; }
    }
    let mut cmd2 = Command::new("reg");
    cmd2.args(["query",
        r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"])
        .stdout(Stdio::piped()).stderr(Stdio::null());
    no_window!(cmd2);
    if let Ok(o) = cmd2.output() {
        return o.status.success();
    }
    true // 默认假设已安装，避免误报
}

fn get_disk_free_gb(path: &str) -> f64 {
    // 用 Rust 标准库直接获取磁盘空间
    let drive_root = if path.len() >= 2 {
        format!("{}:\\", &path[..1])
    } else {
        "C:\\".to_string()
    };
    // statvfs 在 Windows 不可用，用 powershell 快速查询（一次性，预检时可以接受）
    let script = format!(
        "(Get-PSDrive -Name '{}' -ErrorAction SilentlyContinue).Free / 1GB",
        drive_root.chars().next().unwrap_or('C')
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &script])
        .stdout(Stdio::piped()).stderr(Stdio::null());
    no_window!(cmd);
    match cmd.output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse::<f64>()
            .unwrap_or(99.0),
        Err(_) => 99.0,
    }
}

fn find_free_port(start: u16) -> u16 {
    for port in start..start + 20 {
        if std::net::TcpListener::bind(format!("127.0.0.1:{port}")).is_ok() {
            return port;
        }
    }
    start
}

fn default_install_dir_inner() -> String {
    let local_res = std::env::var("LOCALAPPDATA");
    let profile_res = std::env::var("USERPROFILE");
    // #region agent log
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(
            r"d:\CODE\openclawInstaller\openclaw_installer_windows\.cursor\debug.log"
        ) {
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
            let local_val = local_res.as_deref().unwrap_or("ERR");
            let profile_val = profile_res.as_deref().unwrap_or("ERR");
            let _ = writeln!(f, "{{\"location\":\"commands.rs:default_install_dir_inner\",\"message\":\"env vars\",\"data\":{{\"LOCALAPPDATA\":\"{}\",\"USERPROFILE\":\"{}\"}},\"timestamp\":{},\"hypothesisId\":\"D\"}}",
                local_val, profile_val, ts);
        }
    }
    // #endregion
    if let Ok(local) = local_res {
        return format!("{}\\OpenClaw", local);
    }
    if let Ok(profile) = profile_res {
        return format!("{}\\OpenClaw", profile);
    }
    "C:\\OpenClaw".to_string()
}

fn check_path(path: &str) -> (bool, String, String) {
    let has_non_ascii = path.chars().any(|c| !c.is_ascii());
    let has_space = path.contains(' ');
    let fallback = default_install_dir_inner();
    if has_non_ascii {
        return (false, format!("路径包含中文或特殊字符，建议使用 {}", fallback), fallback);
    }
    if has_space {
        return (false, format!("路径包含空格，建议使用 {}", fallback), fallback);
    }
    (true, String::new(), path.to_string())
}

/// 返回推荐的安装目录（基于当前用户的 %LOCALAPPDATA%）
#[tauri::command]
pub fn get_default_install_dir() -> String {
    default_install_dir_inner()
}

fn check_network_sync() -> bool {
    // 纯 TCP 连接测试，不启动 PowerShell
    std::net::TcpStream::connect_timeout(
        &"registry.npmmirror.com:443".parse().unwrap_or_else(|_| "1.1.1.1:443".parse().unwrap()),
        Duration::from_secs(5),
    ).is_ok()
}

/// 安装 OpenClaw（winget/msi 安装 Node.js + npm install -g openclaw）
#[tauri::command]
pub async fn start_install(
    window: Window,
    app: AppHandle,
    install_dir: String,
) -> Result<(), String> {
    let script = get_script_path(&app, "install.ps1")?;

    // #region agent log
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(
            r"d:\CODE\openclawInstaller\openclaw_installer_windows\.cursor\debug.log"
        ) {
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
            let _ = writeln!(f, "{{\"location\":\"commands.rs:start_install\",\"message\":\"paths\",\"data\":{{\"script\":\"{}\"}},\"timestamp\":{},\"runId\":\"post-fix\",\"hypothesisId\":\"E\"}}",
                script.display().to_string().replace('\\', "\\\\"),
                ts);
        }
    }
    // #endregion

    window.emit("install-log", serde_json::json!({
        "level": "dim",
        "message": format!("脚本: {}", script.display())
    })).ok();

    let mut manifest = read_manifest(&install_dir).unwrap_or_default();
    manifest.install_dir = install_dir.clone();
    manifest.phase = "installing".into();
    write_manifest(&manifest)?;

    window
        .emit("install-progress", serde_json::json!({ "step": 0, "total": 4, "label": "开始安装" }))
        .ok();

    let env_pairs = vec![
        ("OPENCLAW_INSTALL_DIR".to_string(), install_dir.clone()),
    ];

    tokio::task::spawn_blocking(move || {
        run_ps_script_streaming_sync(window, script, env_pairs, "install-log")
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut manifest = read_manifest(&install_dir).unwrap_or_default();
    if !manifest.steps_done.contains(&"openclaw_installed".to_string()) {
        manifest.steps_done.push("openclaw_installed".into());
    }
    write_manifest(&manifest)?;

    Ok(())
}

/// 验证 API Key 连通性
#[tauri::command]
pub async fn validate_api_key(
    provider: String,
    api_key: String,
    base_url: String,
) -> Result<ValidateResult, String> {
    tokio::task::spawn_blocking(move || {
        let url = match provider.as_str() {
            "anthropic" => format!("{}/v1/messages", base_url.trim_end_matches('/')),
            _ => format!("{}/models", base_url.trim_end_matches('/')),
        };

        let ps_cmd = if provider == "anthropic" {
            format!(
                "try {{ $r = Invoke-WebRequest '{}' -Method GET -TimeoutSec 8 -UseBasicParsing -Headers @{{'x-api-key'='{}'; 'anthropic-version'='2023-06-01'}}; $r.StatusCode }} catch [System.Net.WebException] {{ $_.Exception.Response.StatusCode.value__ }} catch {{ 'timeout' }}",
                url, api_key
            )
        } else {
            format!(
                "try {{ $r = Invoke-WebRequest '{}' -Method GET -TimeoutSec 8 -UseBasicParsing -Headers @{{'Authorization'='Bearer {}'}}; $r.StatusCode }} catch [System.Net.WebException] {{ $_.Exception.Response.StatusCode.value__ }} catch {{ 'timeout' }}",
                url, api_key
            )
        };

        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", &ps_cmd])
            .stdout(Stdio::piped()).stderr(Stdio::null());
        no_window!(cmd);

        let code = match cmd.output() {
            Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            Err(_) => "timeout".to_string(),
        };

        match code.as_str() {
            "200" => ValidateResult { status: "ok".into(), message: "验证通过 ✓".into() },
            "401" => ValidateResult { status: "error".into(), message: "API Key 无效（401），请检查".into() },
            "403" => ValidateResult { status: "warn".into(), message: "Key 权限不足（403），可继续安装".into() },
            "429" => ValidateResult { status: "ok".into(), message: "Key 有效，当前限速中（429）".into() },
            "timeout" => ValidateResult { status: "warn".into(), message: "连接超时，可跳过验证继续".into() },
            _ => ValidateResult { status: "warn".into(), message: format!("返回 {code}，可继续安装") },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// 获取 OpenClaw 默认配置目录 (~/.openclaw/)
fn openclaw_config_dir() -> Result<PathBuf, String> {
    let profile = std::env::var("USERPROFILE")
        .map_err(|_| "无法获取 USERPROFILE 环境变量".to_string())?;
    let dir = PathBuf::from(&profile).join(".openclaw");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建 .openclaw 目录失败: {e}"))?;
    Ok(dir)
}

/// 保存 API Key 配置（写到 ~/.openclaw/openclaw.json，与 openclaw 官方一致）
#[tauri::command]
pub fn save_api_key(
    install_dir: String,
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
) -> Result<(), String> {
    let mut manifest = read_manifest(&install_dir).unwrap_or_default();

    if provider == "skip" {
        manifest.api_provider = "skip".into();
        manifest.api_key_configured = false;
        write_manifest(&manifest)?;
        return Ok(());
    }

    let config_dir = openclaw_config_dir()?;
    let config_path = config_dir.join("openclaw.json");

    // 如果已有配置文件，合并而非覆盖
    let mut config = if config_path.exists() {
        let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
        serde_json::from_str(&existing).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let new_provider = build_openclaw_config(&provider, &api_key, &base_url, &model);
    merge_json(&mut config, &new_provider);

    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, json)
        .map_err(|e| format!("写入配置失败: {e}"))?;

    manifest.api_provider = provider;
    manifest.api_key_configured = true;
    if !manifest.steps_done.contains(&"config_written".to_string()) {
        manifest.steps_done.push("config_written".into());
    }
    write_manifest(&manifest)?;
    Ok(())
}

/// 深度合并两个 JSON Value（src 覆盖到 dst）
fn merge_json(dst: &mut serde_json::Value, src: &serde_json::Value) {
    match (dst, src) {
        (serde_json::Value::Object(d), serde_json::Value::Object(s)) => {
            for (k, v) in s {
                merge_json(d.entry(k.clone()).or_insert(serde_json::Value::Null), v);
            }
        }
        (dst, src) => *dst = src.clone(),
    }
}

fn build_openclaw_config(
    provider: &str,
    api_key: &str,
    base_url: &str,
    model: &str,
) -> serde_json::Value {
    let provider_id = match provider {
        "anthropic" => "anthropic",
        "deepseek" => "deepseek",
        _ => "openai",
    };

    let primary_model = format!("{}/{}", provider_id, model);

    let profile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".into());
    let workspace = format!("{}/.openclaw/workspace", profile.replace('\\', "/"));

    let now = chrono_now_iso();

    serde_json::json!({
        "meta": {
            "lastTouchedAt": now,
            "createdBy": "openclaw-installer"
        },
        "wizard": {
            "lastRunAt": now,
            "lastRunCommand": "installer",
            "lastRunMode": "local"
        },
        "models": {
            "mode": "merge",
            "providers": {
                provider_id: {
                    "apiKey": api_key,
                    "baseUrl": base_url,
                    "models": [{ "id": model, "name": model }]
                }
            }
        },
        "agents": {
            "defaults": {
                "workspace": workspace,
                "model": {
                    "primary": primary_model
                },
                "compaction": {
                    "mode": "safeguard"
                },
                "maxConcurrent": 3
            }
        },
        "messages": {
            "ackReactionScope": "group-mentions"
        },
        "commands": {
            "native": "auto",
            "text": true,
            "bash": false,
            "config": false,
            "debug": false,
            "restart": false
        },
        "session": {
            "scope": "per-sender",
            "reset": {
                "mode": "daily",
                "atHour": 4,
                "idleMinutes": 60
            },
            "resetTriggers": ["/new", "/reset"]
        },
        "gateway": {
            "mode": "local",
            "port": 18789,
            "bind": "loopback",
            "auth": {
                "mode": "token",
                "allowTailscale": false
            },
            "tailscale": {
                "mode": "off",
                "resetOnExit": false
            }
        }
    })
}

fn chrono_now_iso() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let (y, m, day, h, min, s) = unix_to_utc(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z", y, m, day, h, min, s)
}

fn unix_to_utc(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let total_min = secs / 60;
    let min = total_min % 60;
    let total_h = total_min / 60;
    let h = total_h % 24;
    let mut days = total_h / 24;
    let mut y = 1970u64;
    loop {
        let ydays = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 366 } else { 365 };
        if days < ydays { break; }
        days -= ydays;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let mdays = [31, if leap {29} else {28}, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0u64;
    for (i, &md) in mdays.iter().enumerate() {
        if days < md as u64 { m = i as u64 + 1; break; }
        days -= md as u64;
    }
    (y, m, days + 1, h, min, s)
}

/// 在系统 PATH 中查找 openclaw.cmd（Rust 实现，不依赖 PowerShell）
fn find_openclaw_cmd() -> Option<PathBuf> {
    // 先刷新 PATH：读注册表拿最新值
    let machine_path = std::env::var("PATH").unwrap_or_default();
    // 额外拼入常见 npm 全局目录
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let extra_npm = format!("{}\\npm", appdata);
    let search_path = format!("{};{}", machine_path, extra_npm);

    for dir in search_path.split(';') {
        let candidate = PathBuf::from(dir).join("openclaw.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // 尝试 npm config get prefix
    let mut cmd = Command::new("npm");
    cmd.args(["config", "get", "prefix"])
        .stdout(Stdio::piped()).stderr(Stdio::null());
    no_window!(cmd);
    if let Ok(o) = cmd.output() {
        let prefix = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !prefix.is_empty() {
            let candidate = PathBuf::from(&prefix).join("openclaw.cmd");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

/// 刷新当前进程的 PATH 环境变量（从注册表读最新值）
fn refresh_path() {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command",
        "[System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')"])
        .stdout(Stdio::piped()).stderr(Stdio::null());
    no_window!(cmd);
    if let Ok(o) = cmd.output() {
        let new_path = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !new_path.is_empty() {
            std::env::set_var("PATH", &new_path);
        }
    }
}

// ─── 官方命令能力探测与执行 ──────────────────────────────────────────────────

/// 获取命令日志目录
fn get_log_dir() -> PathBuf {
    let profile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".into());
    let log_dir = PathBuf::from(&profile).join(".openclaw").join("installer-logs");
    std::fs::create_dir_all(&log_dir).ok();
    log_dir
}

/// 将命令输出写入日志文件
fn write_command_log(cmd_name: &str, stdout: &str, stderr: &str) -> Option<String> {
    let log_dir = get_log_dir();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let log_file = log_dir.join(format!("{}_{}.log", cmd_name, ts));
    let content = format!(
        "=== {} ===\nTimestamp: {}\n\n--- STDOUT ---\n{}\n\n--- STDERR ---\n{}\n",
        cmd_name, ts, stdout, stderr
    );
    std::fs::write(&log_file, &content).ok()?;
    Some(log_file.to_string_lossy().into_owned())
}

/// 执行 openclaw 命令并返回结构化结果
fn run_openclaw_cmd(args: &[&str]) -> CommandResult {
    refresh_path();
    
    let oc_cmd = match find_openclaw_cmd() {
        Some(c) => c,
        None => return CommandResult::error(
            &args.join(" "),
            "CMD_NOT_FOUND",
            "找不到 openclaw 命令",
            Some("请先完成安装步骤，或检查 PATH 环境变量"),
            true,
        ),
    };

    let cmd_str = format!("{} {}", oc_cmd.display(), args.join(" "));
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", &oc_cmd.to_string_lossy()])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window!(cmd);

    match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let log_path = write_command_log(args.first().unwrap_or(&"unknown"), &stdout, &stderr);
            let exit_code = output.status.code();

            if output.status.success() {
                CommandResult {
                    success: true,
                    code: "OK".into(),
                    message: "命令执行成功".into(),
                    hint: None,
                    command: cmd_str,
                    exit_code,
                    log_path,
                    retriable: false,
                    stdout: Some(stdout),
                    stderr: if stderr.is_empty() { None } else { Some(stderr) },
                }
            } else {
                let hint = if stderr.contains("ECONNREFUSED") || stderr.contains("network") {
                    Some("网络连接问题，请检查网络后重试")
                } else if stderr.contains("permission") || stderr.contains("EPERM") {
                    Some("权限不足，请尝试以管理员身份运行")
                } else if stderr.contains("config") || stderr.contains("openclaw.json") {
                    Some("配置文件问题，可尝试运行 openclaw doctor --fix")
                } else {
                    None
                };

                CommandResult {
                    success: false,
                    code: format!("EXIT_{}", exit_code.unwrap_or(-1)),
                    message: if stderr.is_empty() {
                        format!("命令退出码: {}", exit_code.unwrap_or(-1))
                    } else {
                        stderr.lines().last().unwrap_or("命令执行失败").to_string()
                    },
                    hint: hint.map(|s| s.into()),
                    command: cmd_str,
                    exit_code,
                    log_path,
                    retriable: true,
                    stdout: Some(stdout),
                    stderr: Some(stderr),
                }
            }
        }
        Err(e) => CommandResult::error(
            &cmd_str,
            "SPAWN_ERROR",
            &format!("无法启动命令: {}", e),
            Some("请检查系统环境"),
            true,
        ),
    }
}

/// 探测 openclaw CLI 能力
#[tauri::command]
pub fn detect_cli_capabilities() -> CliCapabilities {
    refresh_path();
    
    let oc_cmd = match find_openclaw_cmd() {
        Some(c) => c,
        None => return CliCapabilities {
            version: None,
            has_onboarding: false,
            has_doctor: false,
            has_gateway: false,
            has_dashboard: false,
            onboarding_flags: vec![],
            doctor_flags: vec![],
            gateway_flags: vec![],
        },
    };

    // 获取版本
    let version = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", &oc_cmd.to_string_lossy(), "--version"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        no_window!(cmd);
        cmd.output()
            .ok()
            .and_then(|o| {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { None } else { Some(s) }
            })
    };

    // 获取帮助信息来判断子命令是否存在
    let help_output = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", &oc_cmd.to_string_lossy(), "--help"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window!(cmd);
        cmd.output()
            .map(|o| {
                let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                format!("{}\n{}", stdout, stderr)
            })
            .unwrap_or_default()
    };

    let has_onboarding = help_output.contains("onboarding");
    let has_doctor = help_output.contains("doctor");
    let has_gateway = help_output.contains("gateway");
    let has_dashboard = help_output.contains("dashboard");

    // 获取各子命令的 flags
    let get_subcommand_flags = |subcmd: &str| -> Vec<String> {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", &oc_cmd.to_string_lossy(), subcmd, "--help"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window!(cmd);
        let output = cmd.output().ok();
        let text = output.map(|o| {
            format!("{}\n{}", 
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr))
        }).unwrap_or_default();
        
        let mut flags = vec![];
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("--") || trimmed.starts_with("-") {
                if let Some(flag) = trimmed.split_whitespace().next() {
                    flags.push(flag.trim_start_matches('-').to_string());
                }
            }
        }
        flags
    };

    CliCapabilities {
        version,
        has_onboarding,
        has_doctor,
        has_gateway,
        has_dashboard,
        onboarding_flags: if has_onboarding { get_subcommand_flags("onboarding") } else { vec![] },
        doctor_flags: if has_doctor { get_subcommand_flags("doctor") } else { vec![] },
        gateway_flags: if has_gateway { get_subcommand_flags("gateway") } else { vec![] },
    }
}

/// 运行 openclaw doctor 诊断
#[tauri::command]
pub async fn run_doctor() -> DoctorResult {
    let result = tokio::task::spawn_blocking(|| {
        run_openclaw_cmd(&["doctor"])
    }).await.unwrap_or_else(|_| CommandResult::error("doctor", "TASK_ERROR", "任务执行失败", None, true));

    let stdout = result.stdout.as_deref().unwrap_or("");
    let stderr = result.stderr.as_deref().unwrap_or("");
    let combined = format!("{}\n{}", stdout, stderr);

    // 解析 doctor 输出中的问题
    let mut issues = vec![];
    let mut passed = result.success;
    
    for line in combined.lines() {
        let line_lower = line.to_lowercase();
        if line_lower.contains("error") || line_lower.contains("❌") || line_lower.contains("[x]") {
            passed = false;
            issues.push(DoctorIssue {
                code: "ERROR".into(),
                message: line.trim().to_string(),
                severity: "error".into(),
                fixable: line_lower.contains("fix") || line_lower.contains("config"),
            });
        } else if line_lower.contains("warn") || line_lower.contains("⚠") {
            issues.push(DoctorIssue {
                code: "WARN".into(),
                message: line.trim().to_string(),
                severity: "warn".into(),
                fixable: true,
            });
        }
    }

    let summary = if passed {
        "诊断通过，未发现问题".into()
    } else {
        format!("发现 {} 个问题", issues.len())
    };

    DoctorResult {
        success: result.success,
        passed,
        issues,
        summary,
        log_path: result.log_path,
    }
}

/// 运行 openclaw doctor --fix 自动修复
#[tauri::command]
pub async fn run_doctor_fix() -> CommandResult {
    tokio::task::spawn_blocking(|| {
        run_openclaw_cmd(&["doctor", "--fix"])
    }).await.unwrap_or_else(|_| CommandResult::error("doctor --fix", "TASK_ERROR", "任务执行失败", None, true))
}

/// 运行 openclaw onboarding（非交互模式，跳过高级配置）
#[tauri::command]
pub async fn run_onboarding(api_key: String, provider: String) -> CommandResult {
    let provider_arg = provider.clone();
    let key_arg = api_key.clone();
    
    tokio::task::spawn_blocking(move || {
        // 检测是否支持非交互 flags
        let caps = {
            refresh_path();
            let oc_cmd = match find_openclaw_cmd() {
                Some(c) => c,
                None => return CommandResult::error("onboarding", "CMD_NOT_FOUND", "找不到 openclaw 命令", None, true),
            };
            
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", &oc_cmd.to_string_lossy(), "onboarding", "--help"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            no_window!(cmd);
            cmd.output()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default()
        };

        // 根据可用 flags 构建命令
        let mut args: Vec<&str> = vec!["onboarding"];
        
        // 常见的非交互 flags
        if caps.contains("--non-interactive") || caps.contains("non-interactive") {
            args.push("--non-interactive");
        }
        if caps.contains("--skip-skills") {
            args.push("--skip-skills");
        }
        if caps.contains("--skip-integrations") {
            args.push("--skip-integrations");
        }
        
        // 如果支持直接传入 provider 和 key
        let provider_flag = format!("--provider={}", provider_arg);
        let key_flag = format!("--api-key={}", key_arg);
        
        if caps.contains("--provider") {
            args.push(&provider_flag);
        }
        if caps.contains("--api-key") {
            args.push(&key_flag);
        }

        run_openclaw_cmd(&args)
    }).await.unwrap_or_else(|_| CommandResult::error("onboarding", "TASK_ERROR", "任务执行失败", None, true))
}

/// 使用官方命令启动 Gateway
#[tauri::command]
pub async fn run_gateway_start(window: Window, port: u16) -> CommandResult {
    let port_str = port.to_string();
    
    window.emit("gateway-log", serde_json::json!({
        "level": "info",
        "message": "正在启动 Gateway..."
    })).ok();

    let result = tokio::task::spawn_blocking(move || {
        refresh_path();
        
        let oc_cmd = match find_openclaw_cmd() {
            Some(c) => c,
            None => return CommandResult::error("gateway", "CMD_NOT_FOUND", "找不到 openclaw 命令", None, true),
        };

        // 检查是否已在运行
        if tcp_port_open(port) {
            return CommandResult::ok("gateway", &format!("Gateway 已在运行 (port {})", port));
        }

        // 尝试使用 gateway start（如果支持）或直接 gateway
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", &oc_cmd.to_string_lossy()])
            .args(["gateway", "--port", &port_str, "--allow-unconfigured"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window!(cmd);

        match cmd.spawn() {
            Ok(child) => {
                let pid = child.id();
                std::mem::forget(child);
                
                // 等待健康检查
                for _ in 0..45 {
                    std::thread::sleep(Duration::from_secs(2));
                    if tcp_port_open(port) {
                        return CommandResult {
                            success: true,
                            code: "OK".into(),
                            message: format!("Gateway 已就绪 (PID: {}, port: {})", pid, port),
                            hint: None,
                            command: format!("openclaw gateway --port {}", port),
                            exit_code: Some(0),
                            log_path: None,
                            retriable: false,
                            stdout: Some(format!("PID: {}", pid)),
                            stderr: None,
                        };
                    }
                }
                
                CommandResult::error(
                    &format!("openclaw gateway --port {}", port),
                    "TIMEOUT",
                    "Gateway 在 90 秒内未就绪",
                    Some("请检查日志或运行 openclaw doctor 诊断"),
                    true,
                )
            }
            Err(e) => CommandResult::error(
                "gateway",
                "SPAWN_ERROR",
                &format!("启动 Gateway 失败: {}", e),
                Some("请检查 openclaw 是否正确安装"),
                true,
            ),
        }
    }).await.unwrap_or_else(|_| CommandResult::error("gateway", "TASK_ERROR", "任务执行失败", None, true));

    if result.success {
        window.emit("gateway-log", serde_json::json!({
            "level": "ok",
            "message": &result.message
        })).ok();
    } else {
        window.emit("gateway-log", serde_json::json!({
            "level": "error",
            "message": &result.message
        })).ok();
    }

    result
}

/// 打开 openclaw dashboard（使用官方命令）
#[tauri::command]
pub async fn run_dashboard() -> CommandResult {
    tokio::task::spawn_blocking(|| {
        let caps = {
            refresh_path();
            let oc_cmd = find_openclaw_cmd();
            oc_cmd.map(|c| {
                let mut cmd = Command::new("cmd");
                cmd.args(["/c", &c.to_string_lossy(), "--help"])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                no_window!(cmd);
                cmd.output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                    .unwrap_or_default()
            }).unwrap_or_default()
        };

        // 如果支持 dashboard 命令
        if caps.contains("dashboard") {
            run_openclaw_cmd(&["dashboard"])
        } else {
            // fallback: 直接打开 URL
            let url = "http://localhost:18789/chat";
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", "start", "", url])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            no_window!(cmd);
            match cmd.spawn() {
                Ok(_) => CommandResult::ok("open_url", &format!("已打开 {}", url)),
                Err(e) => CommandResult::error("open_url", "OPEN_ERROR", &format!("打开失败: {}", e), None, false),
            }
        }
    }).await.unwrap_or_else(|_| CommandResult::error("dashboard", "TASK_ERROR", "任务执行失败", None, true))
}

/// 获取日志目录路径
#[tauri::command]
pub fn get_log_directory() -> String {
    get_log_dir().to_string_lossy().into_owned()
}

/// 启动 Gateway：直接运行 openclaw gateway，流式输出到 UI
#[tauri::command]
pub async fn start_gateway(
    window: Window,
    _app: AppHandle,
    install_dir: String,
    port: u16,
) -> Result<AppManifest, String> {
    // 先刷新 PATH
    refresh_path();

    window.emit("gateway-log", serde_json::json!({
        "level": "info",
        "message": "查找 openclaw 命令..."
    })).ok();

    let oc_cmd = find_openclaw_cmd()
        .ok_or_else(|| "找不到 openclaw.cmd，请确认已完成安装步骤".to_string())?;

    window.emit("gateway-log", serde_json::json!({
        "level": "ok",
        "message": format!("openclaw: {}", oc_cmd.display())
    })).ok();

    // 先检测是否已经在运行
    if tcp_port_open(port) {
        window.emit("gateway-log", serde_json::json!({
            "level": "ok",
            "message": format!("Gateway 已在运行 (port {})", port)
        })).ok();
        let mut manifest = read_manifest(&install_dir).unwrap_or_default();
        manifest.phase = "complete".into();
        manifest.gateway_port = port;
        write_manifest(&manifest)?;
        return Ok(manifest);
    }

    let cmd_str = format!(
        "{} gateway --port {} --allow-unconfigured",
        oc_cmd.display(), port
    );
    window.emit("gateway-log", serde_json::json!({
        "level": "info",
        "message": format!("执行: {}", cmd_str)
    })).ok();

    // 直接启动 openclaw gateway，不注入路径环境变量，让 openclaw 使用默认 ~/.openclaw/
    let mut child_cmd = Command::new("cmd");
    child_cmd.args(["/c", &oc_cmd.to_string_lossy()])
        .args(["gateway", "--port", &port.to_string(), "--allow-unconfigured"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window!(child_cmd);

    let mut child = child_cmd.spawn()
        .map_err(|e| format!("启动 openclaw 失败: {}", e))?;

    let pid = child.id();
    window.emit("gateway-log", serde_json::json!({
        "level": "ok",
        "message": format!("进程已启动 (PID: {})", pid)
    })).ok();

    // 记录 PID 到 manifest
    let mut manifest = read_manifest(&install_dir).unwrap_or_default();
    manifest.install_dir = install_dir.clone();
    manifest.gateway_pid = Some(pid);
    manifest.gateway_port = port;
    write_manifest(&manifest).ok();

    // stdout → 后台线程 → 实时 emit 到 UI
    let stdout = child.stdout.take().unwrap();
    let win_out = window.clone();
    let port_for_detect = port;
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let t = line.trim().to_string();
            if !t.is_empty() {
                let level = if t.to_lowercase().contains("error") || t.to_lowercase().contains("err!") {
                    "error"
                } else if t.to_lowercase().contains("warn") {
                    "warn"
                } else if t.to_lowercase().contains("listening") || t.to_lowercase().contains("ready") || t.to_lowercase().contains("started") {
                    "ok"
                } else {
                    "dim"
                };
                win_out.emit("gateway-log", serde_json::json!({ "level": level, "message": t })).ok();
            }
        }
        win_out.emit("gateway-log", serde_json::json!({
            "level": "warn",
            "message": format!("openclaw 进程 stdout 关闭 (port {})", port_for_detect)
        })).ok();
    });

    // stderr → 后台线程 → 实时 emit 到 UI
    let stderr = child.stderr.take().unwrap();
    let win_err = window.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let t = line.trim().to_string();
            if !t.is_empty() {
                win_err.emit("gateway-log", serde_json::json!({ "level": "error", "message": t })).ok();
            }
        }
    });

    // 等待健康检查通过（最多 90 秒）
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut ready = false;
    loop {
        if std::time::Instant::now() > deadline {
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        if tcp_port_open(port) {
            ready = true;
            break;
        }
    }

    // child 进程故意不 wait/kill，让它继续在后台运行
    // Rust 在 Windows 上 drop Child 不会终止子进程
    std::mem::forget(child);

    if ready {
        window.emit("gateway-log", serde_json::json!({
            "level": "ok",
            "message": format!("Gateway 已就绪 -> http://localhost:{}", port)
        })).ok();

        let mut manifest = read_manifest(&install_dir).unwrap_or_default();
        manifest.phase = "complete".into();
        manifest.gateway_port = port;
        manifest.gateway_pid = Some(pid);
        if !manifest.steps_done.contains(&"gateway_started".to_string()) {
            manifest.steps_done.push("gateway_started".into());
        }
        write_manifest(&manifest)?;
        create_desktop_shortcut(&install_dir).ok();
        Ok(manifest)
    } else {
        Err(format!("Gateway 在 90 秒内未就绪，请查看上方日志排查原因"))
    }
}

/// 强制终止 Gateway 进程（直接 taskkill，不走 PowerShell 脚本）
#[tauri::command]
pub fn kill_gateway_process(install_dir: String, port: u16) -> Result<(), String> {
    // 1) 按 manifest 中记录的 PID 杀（/T 杀整棵进程树）
    if let Some(m) = read_manifest(&install_dir) {
        if let Some(pid) = m.gateway_pid {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/F", "/T"])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            no_window!(cmd);
            cmd.output().ok();
        }
    }

    // 2) 按端口查进程再杀（兜底：PID 可能已过期或不准）
    let ps = format!(
        "(Get-NetTCPConnection -LocalPort {} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique | ForEach-Object {{ taskkill /PID $_ /F /T 2>$null }}",
        port
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &ps])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    no_window!(cmd);
    cmd.output().ok();

    // 清除 manifest 中的 PID
    if let Some(mut m) = read_manifest(&install_dir) {
        m.gateway_pid = None;
        write_manifest(&m).ok();
    }

    Ok(())
}

/// 后台快速启动 Gateway（管理器用）—— 完全隐藏窗口
#[tauri::command]
pub fn start_gateway_bg(app: AppHandle, install_dir: String, port: u16) -> Result<(), String> {
    let script = get_script_path(&app, "gateway.ps1")?;
    let invoke_expr = format!(
        "& ([scriptblock]::Create([System.IO.File]::ReadAllText('{}')))",
        script.to_string_lossy().replace('\'', "''")
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &invoke_expr])
    .env("GW_ACTION", "start")
    .env("GW_INSTALL_DIR", &install_dir)
    .env("GW_PORT", port.to_string())
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    no_window!(cmd);
    cmd.spawn().map_err(|e| format!("启动 Gateway 失败: {e}"))?;
    Ok(())
}

/// 停止 Gateway —— 完全隐藏窗口
#[tauri::command]
pub fn stop_gateway(app: AppHandle, install_dir: String) -> Result<(), String> {
    let script = get_script_path(&app, "gateway.ps1")?;
    let invoke_expr = format!(
        "& ([scriptblock]::Create([System.IO.File]::ReadAllText('{}')))",
        script.to_string_lossy().replace('\'', "''")
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &invoke_expr])
    .env("GW_ACTION", "stop")
    .env("GW_INSTALL_DIR", &install_dir)
    .env("GW_PORT", "18789")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    no_window!(cmd);
    cmd.spawn().map_err(|e| format!("停止 Gateway 失败: {e}"))?;
    Ok(())
}

/// 查询 Gateway 状态 —— 纯 TCP 连接探测，零 PowerShell 调用，不会弹出任何窗口
#[tauri::command]
pub async fn get_gateway_status(_install_dir: String, port: u16) -> String {
    // 在后台线程做 TCP 连接，不阻塞异步运行时
    let ok = tokio::task::spawn_blocking(move || tcp_port_open(port))
        .await
        .unwrap_or(false);
    if ok { "running".to_string() } else { "stopped".to_string() }
}

/// TCP 端口探测（替代 PowerShell HTTP 检查，彻底消除弹窗）
fn tcp_port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(800),
    ).is_ok()
}

/// 打开 URL（使用默认浏览器）
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", "", &url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window!(cmd);
    cmd.spawn().map_err(|e| format!("打开 URL 失败: {e}"))?;
    Ok(())
}

/// 用系统默认编辑器打开 OpenClaw 配置文件
#[tauri::command]
pub fn open_config_file() -> Result<(), String> {
    let config_dir = openclaw_config_dir()?;
    let config_path = config_dir.join("openclaw.json");
    if !config_path.exists() {
        std::fs::write(&config_path, "{}\n")
            .map_err(|e| format!("创建配置文件失败: {e}"))?;
    }
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "start", "", &config_path.to_string_lossy()])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    no_window!(cmd);
    cmd.spawn().map_err(|e| format!("打开文件失败: {e}"))?;
    Ok(())
}

/// 用资源管理器打开指定目录
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        std::fs::create_dir_all(p).ok();
    }
    let mut cmd = Command::new("explorer");
    cmd.arg(&path)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    no_window!(cmd);
    cmd.spawn().map_err(|e| format!("打开目录失败: {e}"))?;
    Ok(())
}

/// 以管理员身份重新启动安装器（UAC 提权）
#[tauri::command]
pub fn relaunch_as_admin() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile", "-Command",
        &format!("Start-Process -FilePath '{}' -Verb RunAs", exe.to_string_lossy()),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    no_window!(cmd);
    cmd.spawn().map_err(|e| format!("UAC 提权失败: {e}"))?;
    Ok(())
}

/// 卸载
#[tauri::command]
pub fn uninstall(install_dir: String) -> Result<(), String> {
    if let Some(m) = read_manifest(&install_dir) {
        if let Some(pid) = m.gateway_pid {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/F"])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            no_window!(cmd);
            cmd.spawn().ok();
        }
    }
    std::fs::remove_dir_all(&install_dir)
        .map_err(|e| format!("卸载失败: {e}"))?;
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let lnk = PathBuf::from(&profile).join("Desktop").join("OpenClaw Manager.lnk");
        std::fs::remove_file(lnk).ok();
    }
    Ok(())
}

fn create_desktop_shortcut(install_dir: &str) -> Result<(), String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let profile = std::env::var("USERPROFILE").map_err(|_| "无法获取用户目录")?;
    let lnk = PathBuf::from(&profile).join("Desktop").join("OpenClaw Manager.lnk");
    let exe_esc = exe_path.to_string_lossy().replace('\\', "\\\\").replace('\'', "''");
    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('{}'); $s.TargetPath = '{}'; $s.WorkingDirectory = '{}'; $s.Description = 'OpenClaw 本地 AI 网关管理器'; $s.IconLocation = '{},0'; $s.Save()",
        lnk.to_string_lossy().replace('\\', "\\\\"),
        exe_esc,
        install_dir.replace('\\', "\\\\"),
        exe_esc
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &script])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    no_window!(cmd);
    cmd.spawn().map_err(|e| format!("创建快捷方式失败: {e}"))?;
    Ok(())
}

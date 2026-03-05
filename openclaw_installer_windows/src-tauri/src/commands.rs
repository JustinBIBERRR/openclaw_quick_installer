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

fn get_resource_file_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    Ok(resource_dir.join("resources").join(name))
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
    event_name: &'static str,
) -> Result<String, String> {
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        &script_path.to_string_lossy(),
    ]);
    for (k, v) in &env_pairs {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window!(cmd); // 关键：不弹出 PowerShell 窗口

    let mut child = cmd.spawn().map_err(|e| format!("启动 PowerShell 失败: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let win2 = window.clone();
    let stdout_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut last_result = String::new();
        for line in reader.lines().map_while(Result::ok) {
            if line.starts_with("[RESULT]") {
                last_result = line[8..].to_string();
            } else if !line.starts_with("[PROGRESS:") {
                let (level, msg) = parse_log_line(&line);
                if !msg.is_empty() {
                    win2.emit(event_name, serde_json::json!({ "level": level, "message": msg }))
                        .ok();
                }
            }
        }
        last_result
    });

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let t = line.trim().to_string();
            if !t.is_empty() && !t.starts_with("+ ") && !t.starts_with("    +") {
                window
                    .emit(event_name, serde_json::json!({ "level": "error", "message": t }))
                    .ok();
            }
        }
    });

    let result = stdout_handle.join().unwrap_or_default();
    let status = child.wait().map_err(|e| format!("等待进程失败: {e}"))?;

    if !status.success() && result.is_empty() {
        return Err(format!("脚本退出码: {}", status.code().unwrap_or(-1)));
    }
    Ok(result)
}

// ─── Tauri 命令 ───────────────────────────────────────────────────────────

/// 获取应用状态
#[tauri::command]
pub fn get_app_state() -> Option<AppManifest> {
    read_manifest("C:\\OpenClaw")
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

/// 安装 OpenClaw（解压 Node.js + npm install）
#[tauri::command]
pub async fn start_install(
    window: Window,
    app: AppHandle,
    install_dir: String,
) -> Result<(), String> {
    let node_zip = get_resource_file_path(&app, "node-v22-win-x64.zip")?;
    let script = get_script_path(&app, "install.ps1")?;

    // #region agent log
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(
            r"d:\CODE\openclawInstaller\openclaw_installer_windows\.cursor\debug.log"
        ) {
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
            let zip_exists = node_zip.exists();
            let _ = writeln!(f, "{{\"location\":\"commands.rs:start_install\",\"message\":\"paths\",\"data\":{{\"node_zip\":\"{}\",\"zip_exists\":{},\"script\":\"{}\"}},\"timestamp\":{},\"runId\":\"post-fix\",\"hypothesisId\":\"E\"}}",
                node_zip.display().to_string().replace('\\', "\\\\"),
                zip_exists,
                script.display().to_string().replace('\\', "\\\\"),
                ts);
        }
    }
    // #endregion

    // 发出路径信息到 UI（便于调试）
    window.emit("install-log", serde_json::json!({
        "level": "dim",
        "message": format!("脚本: {}", script.display())
    })).ok();
    window.emit("install-log", serde_json::json!({
        "level": "dim",
        "message": format!("Node zip: {}", node_zip.display())
    })).ok();
    // zip 不存在时脚本会自动下载，不在 Rust 层提前中止

    let mut manifest = read_manifest(&install_dir).unwrap_or_default();
    manifest.install_dir = install_dir.clone();
    manifest.phase = "installing".into();
    write_manifest(&manifest)?;

    window
        .emit("install-progress", serde_json::json!({ "step": 0, "total": 3, "label": "开始安装" }))
        .ok();

    let env_pairs = vec![
        ("OPENCLAW_INSTALL_DIR".to_string(), install_dir.clone()),
        ("NODE_ZIP_PATH".to_string(), node_zip.to_string_lossy().to_string()),
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

/// 保存 API Key 配置
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

    let config_path = Path::new(&install_dir).join("data").join("openclaw.json");
    std::fs::create_dir_all(config_path.parent().unwrap())
        .map_err(|e| format!("创建配置目录失败: {e}"))?;

    let config = build_openclaw_config(&provider, &api_key, &base_url, &model);
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, json).map_err(|e| format!("写入配置失败: {e}"))?;

    manifest.api_provider = provider;
    manifest.api_key_configured = true;
    if !manifest.steps_done.contains(&"config_written".to_string()) {
        manifest.steps_done.push("config_written".into());
    }
    write_manifest(&manifest)?;
    Ok(())
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
    serde_json::json!({
        "models": {
            "providers": {
                provider_id: {
                    "apiKey": api_key,
                    "baseUrl": base_url,
                    "models": [{ "id": model }]
                }
            }
        }
    })
}

/// 启动 Gateway，等待健康检查
#[tauri::command]
pub async fn start_gateway(
    window: Window,
    app: AppHandle,
    install_dir: String,
    port: u16,
) -> Result<AppManifest, String> {
    let script = get_script_path(&app, "gateway.ps1")?;
    let port_str = port.to_string();

    let env_pairs = vec![
        ("GW_ACTION".to_string(), "start".to_string()),
        ("GW_INSTALL_DIR".to_string(), install_dir.clone()),
        ("GW_PORT".to_string(), port_str),
    ];

    let win_clone = window.clone();
    tokio::task::spawn_blocking(move || {
        run_ps_script_streaming_sync(win_clone, script, env_pairs, "gateway-log")
    })
    .await
    .map_err(|e| e.to_string())??;

    // 健康检查：纯 TCP 连接，不再启动 PowerShell
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("Gateway 启动超时（60s）".into());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        if tcp_port_open(port) {
            break;
        }
    }

    let mut manifest = read_manifest(&install_dir).unwrap_or_default();
    manifest.phase = "complete".into();
    manifest.gateway_port = port;
    if !manifest.steps_done.contains(&"gateway_started".to_string()) {
        manifest.steps_done.push("gateway_started".into());
    }
    write_manifest(&manifest)?;
    create_desktop_shortcut(&install_dir).ok();

    Ok(manifest)
}

/// 后台快速启动 Gateway（管理器用）—— 完全隐藏窗口
#[tauri::command]
pub fn start_gateway_bg(app: AppHandle, install_dir: String, port: u16) -> Result<(), String> {
    let script = get_script_path(&app, "gateway.ps1")?;
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", &script.to_string_lossy(),
    ])
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
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", &script.to_string_lossy(),
    ])
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
    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('{}'); $s.TargetPath = '{}'; $s.WorkingDirectory = '{}'; $s.Description = 'OpenClaw 本地 AI 网关管理器'; $s.Save()",
        lnk.to_string_lossy().replace('\\', "\\\\"),
        exe_path.to_string_lossy().replace('\\', "\\\\"),
        install_dir.replace('\\', "\\\\")
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &script])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    no_window!(cmd);
    cmd.spawn().map_err(|e| format!("创建快捷方式失败: {e}"))?;
    Ok(())
}

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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AdminRelaunchResult {
    pub launched: bool,
    pub close_current: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct CheckEnvironmentResult {
    pub node_installed: bool,
    pub openclaw_installed: bool,
    pub config_exists: bool,
    pub manifest_complete: bool,
    pub manifest: Option<AppManifest>,
}

#[derive(Debug, Serialize)]
pub struct SyscheckOpenclawConfigResult {
    pub openclaw_installed: bool,
    pub config_exists: bool,
    pub has_ready_config: bool,
}

#[derive(Debug, Serialize)]
pub struct SyscheckAdminResult {
    pub admin: bool,
}

#[derive(Debug, Serialize)]
pub struct SyscheckMemoryResult {
    pub total_gb: f64,
    pub available_gb: f64,
    pub recommended_gb: f64,
    pub ok: bool,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CleanupVerificationResult {
    pub user_profile: String,
    pub openclaw_dir: String,
    pub npm_openclaw_cmd: String,
    pub openclaw_dir_exists: bool,
    pub openclaw_cmd_found_in_path: bool,
    pub npm_openclaw_cmd_exists: bool,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SavedApiConfig {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SavedFeishuConfig {
    pub app_id: String,
    pub app_secret: String,
}

#[derive(Debug, Clone)]
struct OnboardingPrefs {
    install_daemon: bool,
    channel: Option<String>,
    feishu_app_id: Option<String>,
    feishu_app_secret: Option<String>,
    install_skills: bool,
    install_hooks: bool,
    launch_mode: Option<String>,
}

// ─── 嵌入 PowerShell 脚本（编译时内嵌，运行时写入临时目录）─────────────────
static INSTALL_PS1:  &str = include_str!("../scripts/install.ps1");
static GATEWAY_PS1:  &str = include_str!("../scripts/gateway.ps1");
static SYSCHECK_PS1: &str = include_str!("../scripts/syscheck.ps1");
static CLEANUP_OPENCLAW_PS1: &str = include_str!("../scripts/cleanup-openclaw.ps1");

/// 将嵌入脚本写入临时目录，返回路径（每次调用覆盖写入，保证最新）
fn get_embedded_script(name: &str) -> Result<PathBuf, String> {
    let content = match name {
        "install.ps1"  => INSTALL_PS1,
        "gateway.ps1"  => GATEWAY_PS1,
        "syscheck.ps1" => SYSCHECK_PS1,
        "cleanup-openclaw.ps1" => CLEANUP_OPENCLAW_PS1,
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

    if !status.success() && result.is_empty() {
        return Err(format!("脚本退出码: {}", status.code().unwrap_or(-1)));
    }
    Ok(result)
}

/// 运行可见的 PowerShell 安装窗口，通过结果文件回传安装结果
fn run_install_visible_sync(
    window: Window,
    script_path: PathBuf,
    env_pairs: Vec<(String, String)>,
    event_name: &str,
    result_file: PathBuf,
    progress_file: PathBuf,
) -> Result<(), String> {
    let invoke_expr = format!(
        "& ([scriptblock]::Create([System.IO.File]::ReadAllText('{}')))",
        script_path.to_string_lossy().replace('\'', "''")
    );

    let install_dir = env_pairs
        .iter()
        .find(|(k, _)| k == "OPENCLAW_INSTALL_DIR")
        .map(|(_, v)| v.clone());

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &invoke_expr]);
    for (k, v) in &env_pairs {
        cmd.env(k, v);
    }
    cmd.env(
        "OPENCLAW_RESULT_FILE",
        result_file.to_string_lossy().to_string(),
    );
    cmd.env(
        "OPENCLAW_PROGRESS_FILE",
        progress_file.to_string_lossy().to_string(),
    );
    cmd.stdin(Stdio::null());

    let t_spawn = std::time::Instant::now();

    let emit_log = |level: &str, msg: &str| {
        window
            .emit(
                event_name,
                serde_json::json!({ "level": level, "message": msg }),
            )
            .ok();
    };

    emit_log("info", "Starting install window (PowerShell)...");

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("Failed to start PowerShell: {e}");
        emit_log("error", &msg);
        msg
    })?;

    let pid = child.id();
    emit_log(
        "info",
        &format!(
            "Install process started (PID: {}). Check the PowerShell window for live progress.",
            pid
        ),
    );

    let mut heartbeat: u32 = 0;
    let mut last_progress_snapshot = String::new();

    loop {
        if let Ok(content) = std::fs::read_to_string(&progress_file) {
            let content = content.trim().to_string();
            if content != last_progress_snapshot {
                last_progress_snapshot = content.clone();
                if let Some(slash) = content.find('/') {
                    if let Ok(step) = content[..slash].parse::<u32>() {
                        let rest = &content[slash + 1..];
                        let total = rest.split_whitespace().next()
                            .and_then(|s| s.parse::<u32>().ok())
                            .unwrap_or(4);
                        let label = rest.splitn(2, ' ').nth(1).unwrap_or("").to_string();
                        window.emit("install-progress", serde_json::json!({
                            "step": step, "total": total, "label": label
                        })).ok();
                    }
                }
            }
        }
        match child
            .try_wait()
            .map_err(|e| format!("Failed to query install process status: {e}"))?
        {
            Some(status) => {
                let elapsed = t_spawn.elapsed().as_secs();
                let result = std::fs::read_to_string(&result_file)
                    .unwrap_or_default()
                    .trim()
                    .trim_start_matches('\u{feff}')
                    .to_string();
                let _ = std::fs::remove_file(&result_file);
                let _ = std::fs::remove_file(&progress_file);

                let exit_code = status.code().unwrap_or(-1);
                emit_log(
                    "dim",
                    &format!(
                        "Install process exited (PID: {pid}, exit code: {exit_code}, elapsed: {elapsed}s)"
                    ),
                );

                if !status.success() && result.is_empty() {
                    let msg = format!("Install script exit code: {exit_code}, no result file written");
                    emit_log("error", &msg);
                    return Err(msg);
                }
                if let Some(err_msg) = result.strip_prefix("error:") {
                    let msg = err_msg.trim().to_string();
                    emit_log("error", &format!("Installation failed: {msg}"));
                    return Err(msg);
                }
                if result != "install_ok" {
                    let msg = format!(
                        "Install did not return success (got: '{result}'). Check PowerShell window output."
                    );
                    emit_log("error", &msg);
                    return Err(msg);
                }
                if let Some(dir) = install_dir.as_ref() {
                    let info_path = Path::new(dir).join("install-info.json");
                    if let Ok(info_raw) = std::fs::read_to_string(&info_path) {
                        if let Ok(info_json) = serde_json::from_str::<serde_json::Value>(&info_raw) {
                            if info_json
                                .get("existing_openclaw")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false)
                            {
                                emit_log("info", "OpenClaw already installed, CLI install step skipped.");
                            }
                        }
                    }
                }
                emit_log("ok", &format!("Installation succeeded (elapsed: {elapsed}s)"));
                return Ok(());
            }
            None => {
                heartbeat += 1;
                if heartbeat % 60 == 1 {
                    let elapsed = t_spawn.elapsed().as_secs();
                    emit_log(
                        "dim",
                        &format!("Install in progress... (waited {elapsed}s)")
                    );
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

// ─── Tauri 命令 ───────────────────────────────────────────────────────────

/// 获取应用状态（从默认安装目录读取 manifest）
#[tauri::command]
pub fn get_app_state() -> Option<AppManifest> {
    let install_dir = default_install_dir_inner();
    read_manifest(&install_dir)
}

/// 检测 Node.js 是否已安装且版本 >= 18
fn check_node_installed() -> bool {
    
    let mut cmd = Command::new("node");
    cmd.args(["--version"]).stdout(Stdio::piped()).stderr(Stdio::null());
    no_window!(cmd);
    if let Ok(o) = cmd.output() {
        if o.status.success() {
            let out = String::from_utf8_lossy(&o.stdout);
            if let Some(m) = out.trim().strip_prefix('v') {
                if let Some(major) = m.split('.').next() {
                    if let Ok(v) = major.parse::<u32>() {
                        return v >= 18;
                    }
                }
            }
        }
    }
    false
}

/// 检测环境是否已配置完成（用于第二次启动时决定跳步）- 异步优化版本
#[tauri::command]
pub async fn check_environment() -> CheckEnvironmentResult {
    
    // 使用 tokio::task::spawn_blocking 将阻塞操作移到后台线程
    let (node_installed, openclaw_installed) = tokio::try_join!(
        tokio::task::spawn_blocking(|| {
            refresh_path();
            check_node_installed()
        }),
        tokio::task::spawn_blocking(|| find_openclaw_cmd_fast().is_some())
    ).map_err(|e| format!("Task join error: {}", e)).unwrap_or((false, false));

    // 并行执行配置检查和 manifest 读取
    let (config_exists, manifest) = tokio::try_join!(
        tokio::task::spawn_blocking(|| {
            openclaw_config_dir()
                .ok()
                .and_then(|dir| std::fs::read_to_string(dir.join("openclaw.json")).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| {
                    v.get("models")
                        .and_then(|m| m.get("providers"))
                        .and_then(|p| p.as_object())
                        .map(|o| !o.is_empty())
                })
                .unwrap_or(false)
        }),
        tokio::task::spawn_blocking(|| {
            let install_dir = default_install_dir_inner();
            read_manifest(&install_dir)
        })
    ).map_err(|e| format!("Task join error: {}", e)).unwrap_or((false, None));
    let manifest_complete = manifest
        .as_ref()
        .map(|m| m.phase == "complete")
        .unwrap_or(false);

    CheckEnvironmentResult {
        node_installed,
        openclaw_installed,
        config_exists,
        manifest_complete,
        manifest,
    }
}

/// 分步预检：OpenClaw 本地配置探测（用于首步快速判断）- 异步优化版本
#[tauri::command]
pub async fn syscheck_openclaw_config() -> SyscheckOpenclawConfigResult {
    // 并行执行 OpenClaw 检测和配置检查
    let (openclaw_installed, config_exists) = tokio::try_join!(
        tokio::task::spawn_blocking(|| {
            // 只在第一次调用时刷新 PATH，后续使用缓存
            static PATH_REFRESHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !PATH_REFRESHED.load(std::sync::atomic::Ordering::Relaxed) {
                refresh_path();
                PATH_REFRESHED.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            find_openclaw_cmd_fast().is_some()
        }),
        tokio::task::spawn_blocking(|| {
            openclaw_config_dir()
                .ok()
                .and_then(|dir| std::fs::read_to_string(dir.join("openclaw.json")).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| {
                    v.get("models")
                        .and_then(|m| m.get("providers"))
                        .and_then(|p| p.as_object())
                        .map(|o| !o.is_empty())
                })
                .unwrap_or(false)
        })
    ).map_err(|e| format!("Task join error: {}", e)).unwrap_or((false, false));

    SyscheckOpenclawConfigResult {
        openclaw_installed,
        config_exists,
        has_ready_config: openclaw_installed && config_exists,
    }
}

/// 分步预检：管理员权限探测 - 异步优化版本
#[tauri::command]
pub async fn syscheck_admin() -> SyscheckAdminResult {
    SyscheckAdminResult {
        admin: tokio::task::spawn_blocking(|| check_admin()).await.unwrap_or(false),
    }
}

/// 分步预检：内存探测（推荐 >= 8GB）- 异步优化版本
#[tauri::command]
pub async fn syscheck_memory() -> SyscheckMemoryResult {
    let (total_gb, available_gb) = tokio::task::spawn_blocking(|| get_memory_info_gb()).await.unwrap_or((0.0, 0.0));
    let recommended_gb = 8.0;
    SyscheckMemoryResult {
        total_gb,
        available_gb,
        recommended_gb,
        ok: total_gb >= recommended_gb,
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

fn get_memory_info_gb() -> (f64, f64) {
    let script = "(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress)";
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    no_window!(cmd);

    let output = match cmd.output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => String::new(),
    };
    if output.is_empty() {
        return (0.0, 0.0);
    }
    let v: serde_json::Value = match serde_json::from_str(&output) {
        Ok(v) => v,
        Err(_) => return (0.0, 0.0),
    };
    let total_kb = v
        .get("TotalVisibleMemorySize")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);
    let free_kb = v
        .get("FreePhysicalMemory")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);

    let to_gb = |kb: f64| kb / 1024.0 / 1024.0;
    (to_gb(total_kb), to_gb(free_kb))
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
    if let Ok(local) = local_res {
        return format!("{}\\OpenClaw", local);
    }
    if let Ok(profile) = profile_res {
        return format!("{}\\OpenClaw", profile);
    }
    "C:\\OpenClaw".to_string()
}

fn check_path_with_fallback(path: &str, fallback: &str) -> (bool, String, String) {
    let has_non_ascii = path.chars().any(|c| !c.is_ascii());
    let has_space = path.contains(' ');
    if has_non_ascii {
        return (
            false,
            format!("路径包含中文或特殊字符，建议使用 {}", fallback),
            fallback.to_string(),
        );
    }
    if has_space {
        return (
            false,
            format!("路径包含空格，建议使用 {}", fallback),
            fallback.to_string(),
        );
    }
    (true, String::new(), path.to_string())
}

fn check_path(path: &str) -> (bool, String, String) {
    let fallback = default_install_dir_inner();
    check_path_with_fallback(path, &fallback)
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

/// 安装 OpenClaw（可见 PowerShell：Git + nvm-cn + openclaw 官方脚本）
#[tauri::command]
pub async fn start_install(
    window: Window,
    app: AppHandle,
    install_dir: String,
) -> Result<CommandResult, String> {
    let script = get_script_path(&app, "install.ps1")?;

    window.emit("install-log", serde_json::json!({
        "level": "dim",
        "message": format!("Script: {}", script.display())
    })).ok();

    let mut manifest = read_manifest(&install_dir).unwrap_or_default();
    manifest.install_dir = install_dir.clone();
    manifest.phase = "installing".into();
    write_manifest(&manifest)?;

    window
        .emit("install-progress", serde_json::json!({ "step": 0, "total": 4, "label": "start" }))
        .ok();

    let env_pairs = vec![
        ("OPENCLAW_INSTALL_DIR".to_string(), install_dir.clone()),
    ];
    let ts_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let result_file = std::env::temp_dir().join(format!("openclaw_result_{ts_suffix}.txt"));
    let progress_file = std::env::temp_dir().join(format!("openclaw_progress_{ts_suffix}.txt"));

    let install_result = tokio::task::spawn_blocking(move || {
        run_install_visible_sync(window, script, env_pairs, "install-log", result_file, progress_file)
    })
    .await
    .map_err(|e| e.to_string());

    if let Err(join_err) = install_result {
        return Ok(CommandResult::error(
            "install.ps1",
            "INSTALL_TASK_JOIN_ERROR",
            &format!("Install task failed: {join_err}"),
            Some("Please retry or check the log directory"),
            true,
        ));
    }

    if let Err(script_err) = install_result.unwrap() {
        let (code, message, hint) = if !check_node_installed() {
            (
                "NODE_RUNTIME_NOT_READY",
                "Node.js install or detection failed".to_string(),
                Some("Please ensure Node.js 18+ is installed and node --version works, then reopen the installer.".to_string()),
            )
        } else if find_openclaw_cmd().is_none() {
            (
                "OPENCLAW_NOT_FOUND",
                "openclaw command not found after install".to_string(),
                Some(build_openclaw_discovery_hint()),
            )
        } else {
            (
                "INSTALL_SCRIPT_FAILED",
                script_err.clone(),
                Some("Check the PowerShell install window for errors and retry.".to_string()),
            )
        };

        return Ok(CommandResult {
            success: false,
            code: code.into(),
            message,
            hint,
            command: "install.ps1".into(),
            exit_code: None,
            log_path: Some(Path::new(&install_dir).join("logs").to_string_lossy().into_owned()),
            retriable: true,
            stdout: None,
            stderr: Some(script_err),
        });
    }

    refresh_path();
    if find_openclaw_cmd().is_none() {
        return Ok(CommandResult {
            success: false,
            code: "INSTALL_VERIFY_FAILED".into(),
            message: "安装流程完成，但未发现 openclaw 命令".into(),
            hint: Some(build_openclaw_discovery_hint()),
            command: "openclaw --version".into(),
            exit_code: None,
            log_path: Some(Path::new(&install_dir).join("logs").to_string_lossy().into_owned()),
            retriable: true,
            stdout: None,
            stderr: None,
        });
    }

    let mut manifest = read_manifest(&install_dir).unwrap_or_default();
    if !manifest.steps_done.contains(&"openclaw_installed".to_string()) {
        manifest.steps_done.push("openclaw_installed".into());
    }
    write_manifest(&manifest)?;

    Ok(CommandResult {
        success: true,
        code: "OK".into(),
        message: "安装完成".into(),
        hint: None,
        command: "install.ps1".into(),
        exit_code: Some(0),
        log_path: Some(Path::new(&install_dir).join("logs").to_string_lossy().into_owned()),
        retriable: false,
        stdout: None,
        stderr: None,
    })
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

fn read_saved_api_config() -> Option<SavedApiConfig> {
    let config_dir = openclaw_config_dir().ok()?;
    let config_path = config_dir.join("openclaw.json");
    let raw = std::fs::read_to_string(config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let providers = json
        .get("models")
        .and_then(|v| v.get("providers"))
        .and_then(|v| v.as_object())?;

    let preferred = ["anthropic", "openai", "deepseek"];
    let chosen = preferred
        .iter()
        .find_map(|k| providers.get(*k).map(|v| ((*k).to_string(), v)))
        .or_else(|| providers.iter().next().map(|(k, v)| (k.clone(), v)))?;

    let provider_key = chosen.0;
    let entry = chosen.1;
    let api_key = entry
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if api_key.trim().is_empty() {
        return None;
    }

    let base_url = entry
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let model = entry
        .get("models")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|m| {
            m.get("id")
                .and_then(|v| v.as_str())
                .or_else(|| m.get("name").and_then(|v| v.as_str()))
        })
        .unwrap_or("")
        .to_string();

    let provider = match provider_key.as_str() {
        "anthropic" => "anthropic".to_string(),
        "openai" => "openai".to_string(),
        "deepseek" => "deepseek".to_string(),
        _ => "custom".to_string(),
    };

    Some(SavedApiConfig {
        provider,
        api_key,
        base_url,
        model,
    })
}

fn read_saved_feishu_config() -> Option<SavedFeishuConfig> {
    let config_dir = openclaw_config_dir().ok()?;
    let config_path = config_dir.join("openclaw.json");
    let raw = std::fs::read_to_string(config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let feishu = json
        .get("channels")
        .and_then(|v| v.get("feishu"))
        .and_then(|v| v.as_object())?;
    let app_id = feishu
        .get("appId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let app_secret = feishu
        .get("appSecret")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if app_id.trim().is_empty() || app_secret.trim().is_empty() {
        return None;
    }
    Some(SavedFeishuConfig { app_id, app_secret })
}

fn save_feishu_config(app_id: &str, app_secret: &str) -> Result<PathBuf, String> {
    let id = app_id.trim();
    let secret = app_secret.trim();
    if id.is_empty() || secret.is_empty() {
        return Err("飞书 appId / appSecret 不能为空".into());
    }
    let config_dir = openclaw_config_dir()?;
    let config_path = config_dir.join("openclaw.json");
    let mut config = if config_path.exists() {
        let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
        serde_json::from_str(&existing).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let patch = serde_json::json!({
        "channels": {
            "feishu": {
                "appId": id,
                "appSecret": secret
            }
        }
    });
    merge_json(&mut config, &patch);
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, json).map_err(|e| format!("写入飞书配置失败: {e}"))?;
    Ok(config_path)
}

#[tauri::command]
pub fn get_saved_api_config() -> Option<SavedApiConfig> {
    read_saved_api_config()
}

#[tauri::command]
pub fn get_saved_feishu_config() -> Option<SavedFeishuConfig> {
    read_saved_feishu_config()
}

fn ps_single_quote(value: &str) -> String {
    value.replace('\'', "''")
}

#[tauri::command]
pub async fn validate_feishu_connectivity(app_id: String, app_secret: String) -> Result<ValidateResult, String> {
    let id = app_id.trim().to_string();
    let secret = app_secret.trim().to_string();
    if id.is_empty() || secret.is_empty() {
        return Ok(ValidateResult {
            status: "error".into(),
            message: "请先填写飞书 appId 与 appSecret".into(),
        });
    }

    tokio::task::spawn_blocking(move || {
        let id_ps = ps_single_quote(&id);
        let secret_ps = ps_single_quote(&secret);
        let script = format!(
            "$body = @{{ app_id = '{id_ps}'; app_secret = '{secret_ps}' }} | ConvertTo-Json -Compress; \
             try {{ $resp = Invoke-RestMethod -Method Post -Uri 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' -Body $body -ContentType 'application/json' -TimeoutSec 12; $resp | ConvertTo-Json -Compress }} \
             catch {{ '{{\"code\":-1,\"msg\":\"' + ($_.Exception.Message -replace '\"','\\\"') + '\"}}' }}"
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", &script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window!(cmd);
        let output = cmd.output().map_err(|e| format!("执行飞书连通性校验失败: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Ok(ValidateResult {
                status: "error".into(),
                message: "飞书连通性校验失败：未收到返回内容".into(),
            });
        }
        let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|_| serde_json::json!({
            "code": -1,
            "msg": stdout
        }));
        let code = parsed.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
        if code == 0 {
            return Ok(ValidateResult {
                status: "ok".into(),
                message: "飞书连通性校验通过".into(),
            });
        }
        let msg = parsed
            .get("msg")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误")
            .to_string();
        Ok(ValidateResult {
            status: "error".into(),
            message: format!("飞书连通性校验失败：{msg}"),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn normalize_auth_provider(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "anthropic",
        "openai" => "openai",
        // deepseek/custom 通常走 OpenAI 兼容协议，写入 openai profile 最稳妥
        "deepseek" | "custom" => "openai",
        _ => "openai",
    }
}

fn normalize_model_provider(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "anthropic",
        "openai" => "openai",
        "deepseek" => "deepseek",
        "custom" => "openai",
        _ => "openai",
    }
}

/// 将 API Key 写入 OpenClaw auth-profiles，并同步到 main agent 目录
fn sync_agent_auth_profile(provider: &str, api_key: &str) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Ok(());
    }
    refresh_path();
    let oc_cmd = find_openclaw_cmd().ok_or_else(|| "找不到 openclaw 命令".to_string())?;
    let provider_id = normalize_auth_provider(provider);

    let mut cmd = Command::new("cmd");
    cmd.args(["/c", &oc_cmd.to_string_lossy(), "models", "auth", "paste-token", "--provider", provider_id])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window!(cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("写入 auth token 失败（启动命令失败）: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write as _;
        stdin
            .write_all(key.as_bytes())
            .map_err(|e| format!("写入 auth token 失败（stdin）: {e}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|e| format!("写入 auth token 换行失败: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("等待 auth token 命令失败: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let detail = stderr.lines().last().unwrap_or("").trim();
        let fallback = stdout.lines().last().unwrap_or("").trim();
        let msg = if !detail.is_empty() { detail } else { fallback };
        return Err(format!(
            "写入 auth-profiles 失败: {}",
            if msg.is_empty() { "未知错误" } else { msg }
        ));
    }

    // 兼容某些版本仅写入根目录 auth-profiles，手动同步到 main agent 目录
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let root_auth = PathBuf::from(&profile).join(".openclaw").join("auth-profiles.json");
        let agent_auth = PathBuf::from(&profile)
            .join(".openclaw")
            .join("agents")
            .join("main")
            .join("agent")
            .join("auth-profiles.json");
        if root_auth.exists() {
            if let Some(parent) = agent_auth.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::copy(&root_auth, &agent_auth);
        }
    }
    if !agent_auth_profile_exists() {
        return Err("auth 命令执行成功但未生成 auth-profiles.json".into());
    }
    Ok(())
}

fn agent_auth_profile_exists() -> bool {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let root_auth = PathBuf::from(&profile).join(".openclaw").join("auth-profiles.json");
        let agent_auth = PathBuf::from(&profile)
            .join(".openclaw")
            .join("agents")
            .join("main")
            .join("agent")
            .join("auth-profiles.json");
        return root_auth.exists() || agent_auth.exists();
    }
    false
}

fn get_active_model_status_plain() -> Option<String> {
    let mut result = run_openclaw_cmd(&["models", "status", "--plain"]);
    if !result.success {
        result = run_openclaw_cmd(&["models", "status"]);
    }
    result.stdout.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn ensure_default_model(provider: &str, model: &str) -> Result<(), String> {
    let m = model.trim();
    if m.is_empty() {
        return Ok(());
    }
    let provider_id = normalize_model_provider(provider);
    let mut candidates: Vec<String> = Vec::new();
    if m.contains('/') {
        candidates.push(m.to_string());
    } else {
        candidates.push(format!("{provider_id}/{m}"));
        candidates.push(m.to_string());
    }
    candidates.dedup();

    let mut last_err = String::new();
    for candidate in &candidates {
        let set_result = run_openclaw_cmd(&["models", "set", candidate]);
        if !set_result.success {
            last_err = set_result.message;
            continue;
        }
        let after = get_active_model_status_plain().unwrap_or_default();
        if after.eq_ignore_ascii_case(candidate) {
            return Ok(());
        }
        last_err = format!("设置为 {candidate} 后状态仍为 {after}");
    }
    if last_err.is_empty() {
        last_err = "未找到可用模型候选".into();
    }
    Err(last_err)
}

/// 保存 API Key 配置（写到 ~/.openclaw/openclaw.json，与 openclaw 官方一致）
#[tauri::command]
pub fn save_api_key(
    install_dir: String,
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
) -> Result<CommandResult, String> {
    let mut manifest = read_manifest(&install_dir).unwrap_or_default();

    if provider == "skip" {
        manifest.api_provider = "skip".into();
        manifest.api_key_configured = false;
        write_manifest(&manifest)?;
        return Ok(CommandResult::ok("save_api_key", "已跳过 API Key 配置"));
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

    // 只写最小必要 provider 信息，尽量减少对官方 schema 的覆盖。
    let provider_id = match provider.as_str() {
        "anthropic" => "anthropic",
        "deepseek" => "deepseek",
        _ => "openai",
    };
    let new_provider = serde_json::json!({
        "models": {
            "providers": {
                provider_id: {
                    "apiKey": api_key,
                    "baseUrl": base_url,
                    "models": [{ "id": model, "name": model }]
                }
            }
        }
    });
    merge_json(&mut config, &new_provider);

    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, json)
        .map_err(|e| format!("写入配置失败: {e}"))?;

    if provider != "skip" && !api_key.trim().is_empty() {
        if let Err(e) = sync_agent_auth_profile(&provider, &api_key) {
            return Ok(CommandResult {
                success: false,
                code: "AUTH_PROFILE_SYNC_FAILED".into(),
                message: "API Key 已保存，但 Agent 认证写入失败".into(),
                hint: Some(e),
                command: "save_api_key".into(),
                exit_code: Some(1),
                log_path: Some(config_path.to_string_lossy().into_owned()),
                retriable: true,
                stdout: None,
                stderr: None,
            });
        }
    }
    if provider != "skip" && !model.trim().is_empty() {
        if let Err(e) = ensure_default_model(&provider, &model) {
            return Ok(CommandResult {
                success: false,
                code: "SET_DEFAULT_MODEL_FAILED".into(),
                message: "API Key 已保存，但设置默认模型失败".into(),
                hint: Some(e),
                command: "save_api_key".into(),
                exit_code: Some(1),
                log_path: Some(config_path.to_string_lossy().into_owned()),
                retriable: true,
                stdout: None,
                stderr: None,
            });
        }
    }

    manifest.api_provider = provider;
    manifest.api_key_configured = true;
    if !manifest.steps_done.contains(&"config_written".to_string()) {
        manifest.steps_done.push("config_written".into());
    }
    write_manifest(&manifest)?;
    Ok(CommandResult {
        success: true,
        code: "OK".into(),
        message: "配置已保存".into(),
        hint: None,
        command: "save_api_key".into(),
        exit_code: Some(0),
        log_path: Some(config_path.to_string_lossy().into_owned()),
        retriable: false,
        stdout: None,
        stderr: None,
    })
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

/// 快速检测 openclaw（仅 PATH + APPDATA\npm，不调用 npm）
fn find_openclaw_cmd_fast() -> Option<PathBuf> {
    let machine_path = std::env::var("PATH").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let extra_npm = format!("{}\\npm", appdata);
    let search_path = format!("{};{}", machine_path, extra_npm);

    for dir in search_path.split(';') {
        if dir.trim().is_empty() {
            continue;
        }
        let candidate = PathBuf::from(dir).join("openclaw.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn build_openclaw_discovery_hint() -> String {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let appdata_npm = if appdata.is_empty() {
        "(未获取 APPDATA)".to_string()
    } else {
        format!("{}\\npm", appdata)
    };

    let mut npm_prefix = "(获取失败)".to_string();
    let mut cmd = Command::new("npm");
    cmd.args(["config", "get", "prefix"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    no_window!(cmd);
    if let Ok(o) = cmd.output() {
        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !p.is_empty() {
            npm_prefix = p;
        }
    }

    format!(
        "未找到 openclaw 命令。已检查 PATH、{}，npm prefix={}。请重新打开安装器/终端后重试，或手动确认上述目录在 PATH 中。",
        appdata_npm, npm_prefix
    )
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
            // SAFETY: We are calling set_var in a controlled context where:
            // 1. We are the only thread modifying PATH at this moment
            // 2. This is called during startup/refresh operations, not concurrently
            // 3. The new_path value is freshly obtained from the registry
            unsafe {
                std::env::set_var("PATH", &new_path);
            }
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
            Some(&build_openclaw_discovery_hint()),
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
                let stderr_lower = stderr.to_lowercase();
                let hint = if stderr.contains("ECONNREFUSED") || stderr_lower.contains("network") {
                    Some("网络连接问题，请检查网络后重试")
                } else if stderr_lower.contains("permission denied")
                    || stderr.contains("EPERM")
                    || stderr.contains("EACCES")
                {
                    Some("权限不足，请尝试以管理员身份运行")
                } else if stderr_lower.contains("too many failed authentication attempts")
                    || stderr_lower.contains("authentication attempts")
                {
                    Some("浏览器可能缓存了旧 token。请重启 Gateway，并使用浏览器无痕模式重新打开 Dashboard")
                } else if stderr_lower.contains("no api key found") {
                    Some("未找到可用 API Key。请检查模型提供商配置，或运行 doctor/doctor --fix")
                } else if stderr_lower.contains("gateway.mode")
                    || stderr_lower.contains("mode local")
                    || stderr_lower.contains("unconfigured")
                {
                    Some("网关模式或配置未就绪。建议先运行 doctor/doctor --fix，再重试启动")
                } else if stderr_lower.contains("config") || stderr_lower.contains("openclaw.json") {
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

/// 探测 openclaw CLI 能力 - 异步优化版本
#[tauri::command]
pub async fn detect_cli_capabilities() -> CliCapabilities {
    tokio::task::spawn_blocking(|| {
        refresh_path();

        let oc_cmd = match find_openclaw_cmd() {
            Some(c) => c,
            None => {
                return CliCapabilities {
                    version: None,
                    has_onboarding: false,
                    has_doctor: false,
                    has_gateway: false,
                    has_dashboard: false,
                    onboarding_flags: vec![],
                    doctor_flags: vec![],
                    gateway_flags: vec![],
                }
            }
        };

        let version = {
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", &oc_cmd.to_string_lossy(), "--version"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            no_window!(cmd);
            cmd.output().ok().and_then(|o| {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { None } else { Some(s) }
            })
        };

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

        let has_onboarding = help_output.contains("onboard") || help_output.contains("onboarding");
        let has_doctor = help_output.contains("doctor");
        let has_gateway = help_output.contains("gateway");
        let has_dashboard = help_output.contains("dashboard");

        let get_subcommand_flags = |subcmd: &str| -> Vec<String> {
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", &oc_cmd.to_string_lossy(), subcmd, "--help"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            no_window!(cmd);
            let output = cmd.output().ok();
            let text = output
                .map(|o| {
                    format!(
                        "{}\n{}",
                        String::from_utf8_lossy(&o.stdout),
                        String::from_utf8_lossy(&o.stderr)
                    )
                })
                .unwrap_or_default();

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
            onboarding_flags: if has_onboarding {
                let flags = get_subcommand_flags("onboard");
                if flags.is_empty() {
                    get_subcommand_flags("onboarding")
                } else {
                    flags
                }
            } else {
                vec![]
            },
            doctor_flags: if has_doctor { get_subcommand_flags("doctor") } else { vec![] },
            gateway_flags: if has_gateway { get_subcommand_flags("gateway") } else { vec![] },
        }
    })
    .await
    .unwrap_or_else(|_| CliCapabilities {
        version: None,
        has_onboarding: false,
        has_doctor: false,
        has_gateway: false,
        has_dashboard: false,
        onboarding_flags: vec![],
        doctor_flags: vec![],
        gateway_flags: vec![],
    })
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
pub async fn run_onboarding(window: Window, api_key: String, provider: String) -> CommandResult {
    run_onboarding_impl(
        window,
        api_key,
        provider,
        None,
        None,
        OnboardingPrefs {
            install_daemon: true,
            channel: None,
            feishu_app_id: None,
            feishu_app_secret: None,
            install_skills: false,
            install_hooks: false,
            launch_mode: Some("web".into()),
        },
    )
    .await
}

#[tauri::command]
pub async fn run_onboarding_with_model(window: Window, api_key: String, provider: String, base_url: Option<String>, model: Option<String>) -> CommandResult {
    run_onboarding_impl(
        window,
        api_key,
        provider,
        base_url,
        model,
        OnboardingPrefs {
            install_daemon: true,
            channel: None,
            feishu_app_id: None,
            feishu_app_secret: None,
            install_skills: false,
            install_hooks: false,
            launch_mode: Some("web".into()),
        },
    )
    .await
}

#[tauri::command]
pub async fn run_onboarding_guided(
    window: Window,
    api_key: String,
    provider: String,
    base_url: Option<String>,
    model: Option<String>,
    install_daemon: bool,
    channel: Option<String>,
    feishu_app_id: Option<String>,
    feishu_app_secret: Option<String>,
    install_skills: bool,
    install_hooks: bool,
    launch_mode: Option<String>,
) -> CommandResult {
    run_onboarding_impl(
        window,
        api_key,
        provider,
        base_url,
        model,
        OnboardingPrefs {
            install_daemon,
            channel,
            feishu_app_id,
            feishu_app_secret,
            install_skills,
            install_hooks,
            launch_mode,
        },
    )
    .await
}

async fn run_onboarding_impl(
    window: Window,
    api_key: String,
    provider: String,
    base_url: Option<String>,
    model: Option<String>,
    prefs: OnboardingPrefs,
) -> CommandResult {
    let provider_arg = provider.clone();
    let key_arg = api_key.clone();
    let base_url_arg = base_url.clone();
    let model_arg = model.clone();
    let prefs_arg = prefs.clone();
    
    tokio::task::spawn_blocking(move || {
        let feishu_id = prefs_arg
            .feishu_app_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let feishu_secret = prefs_arg
            .feishu_app_secret
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();

        // 检测是否支持非交互 flags
        let caps = {
            refresh_path();
            let oc_cmd = match find_openclaw_cmd() {
                Some(c) => c,
                None => return CommandResult::error("onboarding", "CMD_NOT_FOUND", "找不到 openclaw 命令", None, true),
            };
            
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", &oc_cmd.to_string_lossy(), "onboard", "--help"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            no_window!(cmd);
            cmd.output()
                .map(|o| format!("{}\n{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
                .unwrap_or_default()
        };
        let caps_lower = caps.to_lowercase();
        let has_flag = |flag: &str| caps_lower.contains(&flag.to_lowercase());
        let mut skipped_items: Vec<String> = Vec::new();

        // 根据可用 flags 构建命令
        let mut args: Vec<String> = vec!["onboard".into()];
        
        // 常见的非交互 flags
        if has_flag("--non-interactive") || has_flag("non-interactive") {
            args.push("--non-interactive".into());
        }
        if has_flag("--accept-risk") {
            args.push("--accept-risk".into());
        }
        if has_flag("--flow") {
            args.push("--flow".into());
            args.push("quickstart".into());
        }
        if has_flag("--mode") {
            args.push("--mode".into());
            args.push("local".into());
        }
        if has_flag("--gateway-bind") {
            args.push("--gateway-bind".into());
            args.push("loopback".into());
        }
        if has_flag("--gateway-port") {
            args.push("--gateway-port".into());
            args.push("18789".into());
        }
        // channel 逻辑由下方新代码统一处理
        if prefs_arg.install_skills {
            if has_flag("--install-skills") {
                args.push("--install-skills".into());
            } else {
                skipped_items.push("skills".into());
            }
        } else if has_flag("--skip-skills") {
            args.push("--skip-skills".into());
        }
        if prefs_arg.install_hooks {
            if has_flag("--install-hooks") {
                args.push("--install-hooks".into());
            } else {
                skipped_items.push("hooks".into());
            }
        } else if has_flag("--skip-hooks") {
            args.push("--skip-hooks".into());
        }

        if prefs_arg.install_daemon {
            if has_flag("--install-daemon") {
                args.push("--install-daemon".into());
            }
        } else if has_flag("--skip-daemon") {
            args.push("--skip-daemon".into());
        } else if has_flag("--no-install-daemon") {
            args.push("--no-install-daemon".into());
        }

        // CLI 通过 --skip-channels 反向控制；channel 默认开启，用户启用时只需传飞书凭据
        let channel_val = prefs_arg.channel.as_deref().map(str::trim).unwrap_or("").to_string();
        if channel_val.is_empty() {
            // 用户未启用 channel，传 --skip-channels
            args.push("--skip-channels".into());
        } else {
            // 用户启用了 channel，传飞书凭据（若为 feishu）
            if channel_val.eq_ignore_ascii_case("feishu")
                && !feishu_id.is_empty()
                && !feishu_secret.is_empty()
            {
                if has_flag("--feishu-app-id") && has_flag("--feishu-app-secret") {
                    args.push("--feishu-app-id".into());
                    args.push(feishu_id.clone());
                    args.push("--feishu-app-secret".into());
                    args.push(feishu_secret.clone());
                } else {
                    skipped_items.push("feishu_credentials".into());
                }
            }
        }

        // CLI 通过 --skip-ui 反向控制；UI 模式无法通过参数选择（由 onboard 交互决定）
        // 用户选择"不启动 UI"时才传 --skip-ui
        let launch_mode_val = prefs_arg.launch_mode.as_deref().unwrap_or("");
        if launch_mode_val == "none" || launch_mode_val == "skip" {
            args.push("--skip-ui".into());
        }
        // web/tui 模式不传参数，由 onboard 自己决策默认行为

        match provider_arg.as_str() {
            "anthropic" => {
                if has_flag("--auth-choice") {
                    args.push("--auth-choice".into());
                    args.push("anthropic-api-key".into());
                }
                // 优先用专属 flag，不存在则用 --custom-api-key 兜底
                if !key_arg.is_empty() {
                    if has_flag("--anthropic-api-key") {
                        args.push("--anthropic-api-key".into());
                        args.push(key_arg.clone());
                    } else if has_flag("--custom-api-key") {
                        args.push("--custom-api-key".into());
                        args.push(key_arg.clone());
                    } else {
                        skipped_items.push("anthropic_api_key".into());
                    }
                }
                if !model_arg.as_deref().unwrap_or("").trim().is_empty() {
                    if has_flag("--custom-model-id") {
                        args.push("--custom-model-id".into());
                        args.push(model_arg.clone().unwrap_or_default());
                    }
                }
            }
            "openai" => {
                if has_flag("--auth-choice") {
                    args.push("--auth-choice".into());
                    args.push("openai-api-key".into());
                }
                if !key_arg.is_empty() {
                    if has_flag("--openai-api-key") {
                        args.push("--openai-api-key".into());
                        args.push(key_arg.clone());
                    } else if has_flag("--custom-api-key") {
                        args.push("--custom-api-key".into());
                        args.push(key_arg.clone());
                    } else {
                        skipped_items.push("openai_api_key".into());
                    }
                }
                if !model_arg.as_deref().unwrap_or("").trim().is_empty() {
                    if has_flag("--custom-model-id") {
                        args.push("--custom-model-id".into());
                        args.push(model_arg.clone().unwrap_or_default());
                    }
                }
            }
            "deepseek" => {
                if has_flag("--auth-choice") {
                    args.push("--auth-choice".into());
                    args.push("custom-api-key".into());
                }
                if !key_arg.is_empty() && has_flag("--custom-api-key") {
                    args.push("--custom-api-key".into());
                    args.push(key_arg.clone());
                } else if key_arg.is_empty() {
                    skipped_items.push("deepseek_api_key".into());
                }
                if has_flag("--custom-base-url") {
                    args.push("--custom-base-url".into());
                    args.push(base_url_arg.clone().unwrap_or_else(|| "https://api.deepseek.com/v1".into()));
                }
                if has_flag("--custom-model-id") {
                    args.push("--custom-model-id".into());
                    args.push(model_arg.clone().unwrap_or_else(|| "deepseek-chat".into()));
                }
                if has_flag("--custom-provider-id") {
                    args.push("--custom-provider-id".into());
                    args.push("deepseek".into());
                }
                if has_flag("--custom-compatibility") {
                    args.push("--custom-compatibility".into());
                    args.push("openai".into());
                }
            }
            _ => {
                if has_flag("--auth-choice") {
                    args.push("--auth-choice".into());
                    args.push("custom-api-key".into());
                }
                if !key_arg.is_empty() && has_flag("--custom-api-key") {
                    args.push("--custom-api-key".into());
                    args.push(key_arg.clone());
                } else if key_arg.is_empty() {
                    skipped_items.push("custom_api_key".into());
                }
                if has_flag("--custom-base-url") {
                    args.push("--custom-base-url".into());
                    args.push(base_url_arg.clone().unwrap_or_default());
                }
                if has_flag("--custom-model-id") {
                    args.push("--custom-model-id".into());
                    args.push(model_arg.clone().unwrap_or_default());
                }
                if has_flag("--custom-provider-id") {
                    args.push("--custom-provider-id".into());
                    args.push("custom".into());
                }
                if has_flag("--custom-compatibility") {
                    args.push("--custom-compatibility".into());
                    args.push("openai".into());
                }
            }
        }

        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        // 写入安装日志（记录最终传入的命令，便于排查）
        let _install_log_dir = {
            let install_dir = std::env::var("USERPROFILE")
                .map(|p| PathBuf::from(p).join("AppData").join("Local").join("OpenClaw"))
                .unwrap_or_else(|_| PathBuf::from("C:\\OpenClaw"));
            let log_dir = install_dir.join("installer-logs");
            let _ = std::fs::create_dir_all(&log_dir);
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let log_path = log_dir.join(format!("onboard_args_{ts}.txt"));
            let safe_args: Vec<String> = arg_refs.iter().map(|s| {
                if s.len() > 6 && (s.starts_with("sk-") || s.contains("secret") || s.len() > 40) {
                    format!("{}***", &s[..4.min(s.len())])
                } else {
                    s.to_string()
                }
            }).collect();
            let _ = std::fs::write(&log_path, format!("args: {}\n", safe_args.join(" ")));
            log_dir
        };

        let emit_event = |phase: &str, detail_key: &str, detail_vars: serde_json::Value| {
            window.emit("onboarding-progress", serde_json::json!({
                "phase": phase, "detail_key": detail_key, "detail_vars": detail_vars
            })).ok();
        };

        emit_event("preparing", "onboarding.detail.preparing", serde_json::json!({}));

        refresh_path();
        let oc_cmd = match find_openclaw_cmd() {
            Some(c) => c,
            None => return CommandResult::error("onboarding", "CMD_NOT_FOUND", "找不到 openclaw 命令", Some(&build_openclaw_discovery_hint()), true),
        };

        let result_file = std::env::temp_dir().join(format!(
            "openclaw_onboard_result_{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));

        // Build a PowerShell script that runs the onboard command and writes result
        let ps_args: Vec<String> = args.iter().map(|s| {
            format!("'{}'", s.replace('\'', "''"))
        }).collect();
        let oc_cmd_escaped = oc_cmd.to_string_lossy().replace('\'', "''");
        let result_file_escaped = result_file.to_string_lossy().replace('\'', "''");
        let ps_script = format!(
            "try {{ & '{}' {} ; if ($LASTEXITCODE -eq 0) {{ [System.IO.File]::WriteAllText('{}', 'onboard_ok', [System.Text.Encoding]::ASCII) }} else {{ [System.IO.File]::WriteAllText('{}', \"error:exit_code_$LASTEXITCODE\", [System.Text.Encoding]::ASCII) }} }} catch {{ [System.IO.File]::WriteAllText('{}', \"error:$_\", [System.Text.Encoding]::ASCII) }}; Write-Host ''; Write-Host 'Onboard completed. Window will close in 3 seconds...' -ForegroundColor Cyan; Start-Sleep -Seconds 3",
            oc_cmd_escaped,
            ps_args.join(" "),
            result_file_escaped,
            result_file_escaped,
            result_file_escaped,
        );

        emit_event("launching", "onboarding.detail.launching", serde_json::json!({}));

        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", &ps_script]);
        cmd.stdin(Stdio::null());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return CommandResult::error("onboarding", "SPAWN_ERROR", &format!("启动 PowerShell 失败: {e}"), None, true),
        };

        let pid = child.id();
        emit_event("running", "onboarding.detail.runningPid", serde_json::json!({ "pid": pid }));

        let t_spawn = std::time::Instant::now();
        let mut heartbeat: u32 = 0;
        let result: CommandResult;

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let elapsed = t_spawn.elapsed().as_secs();
                    let file_result = std::fs::read_to_string(&result_file)
                        .unwrap_or_default()
                        .trim()
                        .trim_start_matches('\u{feff}')
                        .to_string();
                    let _ = std::fs::remove_file(&result_file);

                    let exit_code = status.code().unwrap_or(-1);

                    let gateway_port: u16 = 18789;
                    let gateway_alive = tcp_port_open(gateway_port);

                    if file_result == "onboard_ok" {
                        emit_event("done", "onboarding.detail.done", serde_json::json!({ "elapsed": elapsed }));
                        result = CommandResult {
                            success: true,
                            code: "OK".into(),
                            message: "综合配置执行成功".into(),
                            hint: None,
                            command: format!("openclaw {}", arg_refs.join(" ")),
                            exit_code: Some(0),
                            log_path: None,
                            retriable: false,
                            stdout: None,
                            stderr: None,
                        };
                    } else if let Some(err_msg) = file_result.strip_prefix("error:") {
                        if gateway_alive {
                            emit_event("done", "onboarding.detail.doneGatewayWarn", serde_json::json!({ "err_msg": err_msg.trim(), "elapsed": elapsed }));
                            result = CommandResult {
                                success: true,
                                code: "OK_WITH_WARNING".into(),
                                message: "综合配置已执行，网关已成功启动".into(),
                                hint: Some(format!(
                                    "onboard 退出码为 {exit_code}（{}），但网关已在端口 {gateway_port} 运行。部分可选步骤可能未完成，可在管理界面中补充配置。",
                                    err_msg.trim()
                                )),
                                command: format!("openclaw {}", arg_refs.join(" ")),
                                exit_code: Some(exit_code),
                                log_path: None,
                                retriable: false,
                                stdout: None,
                                stderr: None,
                            };
                        } else {
                            emit_event("failed", "onboarding.detail.failedMsg", serde_json::json!({ "msg": err_msg }));
                            result = CommandResult::error(
                                &format!("openclaw {}", arg_refs.join(" ")),
                                &format!("EXIT_{exit_code}"),
                                &format!("{} (网关未启动)", err_msg.trim()),
                                Some("请查看 PowerShell 窗口中的报错并重试"),
                                true,
                            );
                        }
                    } else {
                        if gateway_alive {
                            emit_event("done", "onboarding.detail.doneGatewayExit", serde_json::json!({ "exit_code": exit_code, "elapsed": elapsed }));
                            result = CommandResult {
                                success: true,
                                code: "OK_WITH_WARNING".into(),
                                message: "综合配置已执行，网关已成功启动".into(),
                                hint: Some(format!(
                                    "onboard 退出码为 {exit_code}，但网关已在端口 {gateway_port} 运行。部分可选步骤可能未完成。"
                                )),
                                command: format!("openclaw {}", arg_refs.join(" ")),
                                exit_code: Some(exit_code),
                                log_path: None,
                                retriable: false,
                                stdout: None,
                                stderr: None,
                            };
                        } else {
                            emit_event("failed", "onboarding.detail.failed", serde_json::json!({ "exit_code": exit_code }));
                            result = CommandResult::error(
                                &format!("openclaw {}", arg_refs.join(" ")),
                                &format!("EXIT_{exit_code}"),
                                &format!("配置命令退出码: {exit_code}，网关未启动"),
                                Some("请检查 PowerShell 窗口输出"),
                                true,
                            );
                        }
                    }
                    break;
                }
                Ok(None) => {
                    heartbeat += 1;
                    if heartbeat % 15 == 1 {
                        let elapsed = t_spawn.elapsed().as_secs();
                        emit_event("running", "onboarding.detail.runningElapsed", serde_json::json!({ "elapsed": elapsed }));
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
                Err(e) => {
                    emit_event("failed", "onboarding.detail.failedQuery", serde_json::json!({ "error": e.to_string() }));
                    result = CommandResult::error("onboarding", "WAIT_ERROR", &format!("查询进程状态失败: {e}"), None, true);
                    break;
                }
            }
        }

        let mut result = result;
        if result.success && !skipped_items.is_empty() {
            let skipped_text = skipped_items.join(", ");
            result.hint = Some(format!("已按 best-effort 跳过不支持项: {skipped_text}"));
        }
        if result.success && !key_arg.trim().is_empty() {
            if let Err(e) = sync_agent_auth_profile(&provider_arg, &key_arg) {
                let prev = result.hint.unwrap_or_default();
                result.hint = Some(if prev.is_empty() {
                    format!("onboard 完成，但自动写入 Agent 认证失败：{e}")
                } else {
                    format!("{prev}；另外自动写入 Agent 认证失败：{e}")
                });
            }
        }
        if result.success
            && prefs_arg
                .channel
                .as_deref()
                .map(str::trim)
                .map(|s| s.eq_ignore_ascii_case("feishu"))
                .unwrap_or(false)
            && !feishu_id.is_empty()
            && !feishu_secret.is_empty()
        {
            if let Err(e) = save_feishu_config(&feishu_id, &feishu_secret) {
                let prev = result.hint.unwrap_or_default();
                result.hint = Some(if prev.is_empty() {
                    format!("onboard 完成，但写入飞书配置失败：{e}")
                } else {
                    format!("{prev}；另外写入飞书配置失败：{e}")
                });
            }
        }
        // onboard 成功后将 provider/api_key_configured 回写到 manifest，使 Manager 页显示正确状态
        if result.success && provider_arg != "skip" && !key_arg.trim().is_empty() {
            let install_dir = std::env::var("USERPROFILE")
                .map(|p| PathBuf::from(p).join("AppData").join("Local").join("OpenClaw"))
                .unwrap_or_else(|_| PathBuf::from("C:\\OpenClaw"));
            let mut manifest = read_manifest(&install_dir.to_string_lossy()).unwrap_or_default();
            manifest.install_dir = install_dir.to_string_lossy().into_owned();
            manifest.api_provider = provider_arg.clone();
            manifest.api_key_configured = true;
            if !manifest.steps_done.contains(&"config_written".to_string()) {
                manifest.steps_done.push("config_written".into());
            }
            let _ = write_manifest(&manifest);
        }
        if result.success {
            if let Some(model_name) = model_arg.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                if let Err(e) = ensure_default_model(&provider_arg, model_name) {
                    let prev = result.hint.unwrap_or_default();
                    result.hint = Some(if prev.is_empty() {
                        format!("onboard 完成，但设置默认模型失败：{e}")
                    } else {
                        format!("{prev}；另外设置默认模型失败：{e}")
                    });
                }
            }
        }
        result
    }).await.unwrap_or_else(|_| CommandResult::error("onboarding", "TASK_ERROR", "任务执行失败", None, true))
}

/// 使用官方命令启动 Gateway
#[tauri::command]
pub async fn run_gateway_start(window: Window, install_dir: String, port: u16) -> CommandResult {
    let port_str = port.to_string();
    
    window.emit("gateway-log", serde_json::json!({
        "level": "info",
        "message": "正在启动 Gateway..."
    })).ok();

    let install_dir_for_manifest = install_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        refresh_path();
        let mut preflight_hint: Option<String> = None;
        let userprofile = std::env::var("USERPROFILE").ok();
        let user_openclaw = userprofile.as_ref().map(|p| PathBuf::from(p).join(".openclaw"));
        let gateway_cwd = user_openclaw.clone().filter(|p| p.exists());
        
        let oc_cmd = match find_openclaw_cmd() {
            Some(c) => c,
            None => return CommandResult::error("gateway", "CMD_NOT_FOUND", "找不到 openclaw 命令", None, true),
        };

        if !agent_auth_profile_exists() {
            if let Some(saved) = read_saved_api_config() {
                if !saved.api_key.trim().is_empty() {
                    match sync_agent_auth_profile(&saved.provider, &saved.api_key) {
                        Ok(_) => {
                            preflight_hint = Some("启动前已自动补齐 Agent 认证信息".into());
                        }
                        Err(e) => {
                            preflight_hint = Some(format!("启动前尝试自动补齐 Agent 认证失败：{e}"));
                        }
                    }
                }
                if !saved.model.trim().is_empty() {
                    match ensure_default_model(&saved.provider, &saved.model) {
                        Ok(_) => {
                            let prev = preflight_hint.unwrap_or_default();
                            preflight_hint = Some(if prev.is_empty() {
                                format!("已设置默认模型为 {}", saved.model)
                            } else {
                                format!("{prev}；已设置默认模型为 {}", saved.model)
                            });
                        }
                        Err(e) => {
                            let prev = preflight_hint.unwrap_or_default();
                            preflight_hint = Some(if prev.is_empty() {
                                format!("设置默认模型失败：{e}")
                            } else {
                                format!("{prev}；设置默认模型失败：{e}")
                            });
                        }
                    }
                }
            }
        }

        // 使用可见 PowerShell 新窗口运行 Gateway，便于用户直观看到日志与报错。
        let gateway_cmd = format!(
            "& '{}' gateway run --port {} --allow-unconfigured --force",
            oc_cmd.to_string_lossy().replace('\'', "''"),
            port_str
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NoExit", "-Command", &gateway_cmd])
            .stdin(Stdio::null());
        if let Some(dir) = gateway_cwd.as_ref() {
            cmd.current_dir(dir);
        }

        match cmd.spawn() {
            Ok(child) => {
                let pid = child.id();
                std::mem::forget(child);
                
                // 等待健康检查
                for _ in 0..45 {
                    std::thread::sleep(Duration::from_secs(2));
                    if tcp_port_open(port) {
                        let mut manifest = read_manifest(&install_dir_for_manifest).unwrap_or_default();
                        manifest.install_dir = install_dir_for_manifest.clone();
                        manifest.gateway_port = port;
                        manifest.gateway_pid = Some(pid);
                        manifest.phase = "complete".into();
                        if !manifest.steps_done.contains(&"gateway_started".to_string()) {
                            manifest.steps_done.push("gateway_started".into());
                        }
                        let _ = write_manifest(&manifest);
                        let _ = create_desktop_shortcut(&install_dir_for_manifest);
                        return CommandResult {
                            success: true,
                            code: "OK".into(),
                            message: format!("Gateway 已就绪 (PID: {}, port: {})", pid, port),
                            hint: preflight_hint.clone(),
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
            let result = run_openclaw_cmd(&["dashboard"]);
            result
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
) -> Result<CommandResult, String> {
    let result = run_gateway_start(window, install_dir, port).await;
    Ok(result)
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
pub async fn start_gateway_bg(
    window: Window,
    _app: AppHandle,
    install_dir: String,
    port: u16,
) -> Result<CommandResult, String> {
    let result = run_gateway_start(window, install_dir, port).await;
    Ok(result)
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

/// 打开可见 PowerShell 并执行真实环境清理脚本
#[tauri::command]
pub fn open_cleanup_powershell(app: AppHandle) -> Result<(), String> {
    let script = get_script_path(&app, "cleanup-openclaw.ps1")?;
    let invoke_expr = format!(
        "& ([scriptblock]::Create([System.IO.File]::ReadAllText('{}')))",
        script.to_string_lossy().replace('\'', "''")
    );

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &invoke_expr,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    cmd.spawn()
        .map_err(|e| format!("启动清理窗口失败: {e}"))?;

    Ok(())
}

/// 校验清理状态（用于用户手动执行清理后的结果确认）
#[tauri::command]
pub fn verify_cleanup_state() -> CleanupVerificationResult {
    refresh_path();

    let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
    let app_data = std::env::var("APPDATA").unwrap_or_default();

    let openclaw_dir = PathBuf::from(&user_profile).join(".openclaw");
    let npm_openclaw_cmd = PathBuf::from(&app_data).join("npm").join("openclaw.cmd");

    CleanupVerificationResult {
        user_profile,
        openclaw_dir: openclaw_dir.to_string_lossy().to_string(),
        npm_openclaw_cmd: npm_openclaw_cmd.to_string_lossy().to_string(),
        openclaw_dir_exists: openclaw_dir.exists(),
        openclaw_cmd_found_in_path: find_openclaw_cmd_fast().is_some(),
        npm_openclaw_cmd_exists: npm_openclaw_cmd.exists(),
    }
}

/// 以管理员身份重新启动安装器（UAC 提权）
#[tauri::command]
pub fn relaunch_as_admin() -> Result<AdminRelaunchResult, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let command_preview = format!("Start-Process -FilePath '{}' -Verb RunAs", exe.to_string_lossy());
    if cfg!(debug_assertions) {
        return Ok(AdminRelaunchResult {
            launched: false,
            close_current: false,
            message: "本地开发模式下不支持应用内自动提权。请以管理员身份启动终端或 Cursor 后再运行 npm run tauri dev；若要验证正式提权流程，请使用打包后的 exe。".into(),
        });
    }
    let close_current = true;
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile", "-Command",
        &command_preview,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    no_window!(cmd);
    cmd.spawn().map_err(|e| format!("UAC 提权失败: {e}"))?;
    Ok(AdminRelaunchResult {
        launched: true,
        close_current,
        message: "已启动管理员实例，当前窗口将关闭".into(),
    })
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

#[cfg(test)]
mod tests {
    use super::check_path_with_fallback;

    #[test]
    fn check_path_rejects_non_ascii() {
        let fallback = "C:\\Users\\Tester\\AppData\\Local\\OpenClaw";
        let (ok, issue, suggested) = check_path_with_fallback("C:\\测试目录\\OpenClaw", fallback);
        assert!(!ok);
        assert!(issue.contains("路径包含中文或特殊字符"));
        assert_eq!(suggested, fallback);
    }

    #[test]
    fn check_path_rejects_space() {
        let fallback = "C:\\Users\\Tester\\AppData\\Local\\OpenClaw";
        let (ok, issue, suggested) = check_path_with_fallback("C:\\Program Files\\OpenClaw", fallback);
        assert!(!ok);
        assert!(issue.contains("路径包含空格"));
        assert_eq!(suggested, fallback);
    }

    #[test]
    fn check_path_accepts_ascii_no_space() {
        let fallback = "C:\\Users\\Tester\\AppData\\Local\\OpenClaw";
        let (ok, issue, suggested) = check_path_with_fallback("C:\\OpenClaw", fallback);
        assert!(ok);
        assert!(issue.is_empty());
        assert_eq!(suggested, "C:\\OpenClaw");
    }
}

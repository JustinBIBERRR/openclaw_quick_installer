# OpenClaw Gateway 进程管理脚本（简化版：使用系统 PATH 中的 openclaw）
# 参数通过环境变量传入（由 Tauri 注入）
$Action     = if ($env:GW_ACTION)      { $env:GW_ACTION }      else { "status" }
$InstallDir = if ($env:GW_INSTALL_DIR) { $env:GW_INSTALL_DIR } else { "C:\OpenClaw" }
$Port       = if ($env:GW_PORT)        { [int]$env:GW_PORT }   else { 18789 }

$ErrorActionPreference = "SilentlyContinue"

function Log-Info  { param($msg) Write-Output "[INFO] $msg" }
function Log-OK    { param($msg) Write-Output "[OK] $msg" }
function Log-Warn  { param($msg) Write-Output "[WARN] $msg" }
function Log-Error { param($msg) Write-Output "[ERROR] $msg" }
function Log-Dim   { param($msg) Write-Output "[DIM] $msg" }

# 路径与配置（openclaw 从系统 PATH 调用，仅需指定配置目录）
$MANIFEST    = "$InstallDir\manifest.json"
$LOG_FILE    = "$InstallDir\logs\gateway.log"
$CONFIG_FILE = "$InstallDir\data\openclaw.json"

$env:OPENCLAW_CONFIG_PATH = $CONFIG_FILE
$env:OPENCLAW_HOME        = "$InstallDir\data"

# ── 辅助：读写 manifest ───────────────────────────────────────────────────

function Read-Manifest {
    if (Test-Path $MANIFEST) {
        try { return Get-Content $MANIFEST -Raw | ConvertFrom-Json } catch {}
    }
    return $null
}

function Write-PID { param($pid_val)
    $m = Read-Manifest
    if ($m) {
        $m.gateway_pid = $pid_val
        $m | ConvertTo-Json -Depth 10 | Out-File $MANIFEST -Encoding utf8
    }
}

# ── 辅助：健康检查 ────────────────────────────────────────────────────────

function Test-GatewayHealth {
    try {
        $r = Invoke-WebRequest "http://localhost:$Port/health" -TimeoutSec 2 -UseBasicParsing
        return $r.StatusCode -lt 500
    } catch { return $false }
}

# ── 启动 ─────────────────────────────────────────────────────────────────

if ($Action -eq "start") {
    Log-Info "启动 Gateway（端口 $Port）..."

    if (Test-GatewayHealth) {
        Log-OK "Gateway 已在运行"
        Write-Output "[RESULT]already_running"
        exit 0
    }

    $portProcess = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($portProcess) {
        $procName = (Get-Process -Id $portProcess.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Log-Warn "端口 $Port 被 $procName 占用"
    }

    New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
    "" | Out-File $LOG_FILE -Encoding utf8

    Log-Info "配置文件: $CONFIG_FILE"
    Log-Info "日志文件: $LOG_FILE"

    $procArgs = @("gateway", "--port", $Port, "--allow-unconfigured", "--auth", "none")

    # 使用系统 PATH 中的 openclaw（npm install -g 后可用）
    $proc = Start-Process -FilePath "openclaw" `
        -ArgumentList $procArgs `
        -RedirectStandardOutput $LOG_FILE `
        -RedirectStandardError  $LOG_FILE `
        -PassThru -WindowStyle Hidden

    if (-not $proc -or -not $proc.Id) {
        Log-Error "无法启动 openclaw，请确认已完成安装（npm install -g openclaw）"
        Write-Output "[RESULT]failed"
        exit 1
    }

    Write-PID $proc.Id
    Log-OK "Gateway 进程已创建（PID: $($proc.Id)）"

    $deadline = (Get-Date).AddSeconds(60)
    $lastLineCount = 0
    $started = $false

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500

        if (Test-Path $LOG_FILE) {
            $lines = Get-Content $LOG_FILE
            if ($lines -and $lines.Count -gt $lastLineCount) {
                $newLines = $lines[$lastLineCount..($lines.Count - 1)]
                foreach ($line in $newLines) {
                    if ($line.Trim() -ne "") { Log-Dim $line }
                }
                $lastLineCount = $lines.Count
            }

            $logContent = ($lines -join " ").ToLower()
            if ($logContent -match "listening on|gateway ready|started on port") {
                $started = $true
                break
            }
            if ($logContent -match "unhandledpromiserejection|error:|eaddrinuse|cannot find module") {
                Log-Error "Gateway 启动失败，检测到错误关键词"
                break
            }
        }

        if (Test-GatewayHealth) {
            $started = $true
            break
        }
    }

    if ($started) {
        Log-OK "Gateway 已就绪 → http://localhost:$Port"
        Write-Output "[RESULT]started:$($proc.Id)"
    } else {
        Log-Error "Gateway 启动超时，请查看日志: $LOG_FILE"
        Write-Output "[RESULT]failed"
        exit 1
    }
}

# ── 停止 ─────────────────────────────────────────────────────────────────

elseif ($Action -eq "stop") {
    $m = Read-Manifest
    $stopped = $false

    try {
        & openclaw gateway stop 2>&1 | Out-Null
        Start-Sleep -Milliseconds 800
        if (-not (Test-GatewayHealth)) {
            $stopped = $true
            Log-OK "Gateway 已优雅停止"
        }
    } catch {}

    if (-not $stopped -and $m -and $m.gateway_pid) {
        Stop-Process -Id $m.gateway_pid -Force -ErrorAction SilentlyContinue
        Log-OK "Gateway 进程已终止（PID: $($m.gateway_pid)）"
        Write-PID $null
    }

    Write-Output "[RESULT]stopped"
}

# ── 状态查询 ─────────────────────────────────────────────────────────────

elseif ($Action -eq "status") {
    if (Test-GatewayHealth) {
        Write-Output "running"
    } else {
        Write-Output "stopped"
    }
}

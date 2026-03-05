# OpenClaw Gateway 进程管理脚本
# 参数通过环境变量传入（由 Tauri 注入）
$Action     = if ($env:GW_ACTION)      { $env:GW_ACTION }      else { "status" }
$InstallDir = if ($env:GW_INSTALL_DIR) { $env:GW_INSTALL_DIR } else { "C:\OpenClaw" }
$Port       = if ($env:GW_PORT)        { [int]$env:GW_PORT }   else { 18789 }

Set-StrictMode -Version Latest
$ErrorActionPreference = "SilentlyContinue"

function Log-Info  { param($msg) Write-Output "[INFO] $msg" }
function Log-OK    { param($msg) Write-Output "[OK] $msg" }
function Log-Warn  { param($msg) Write-Output "[WARN] $msg" }
function Log-Error { param($msg) Write-Output "[ERROR] $msg" }
function Log-Dim   { param($msg) Write-Output "[DIM] $msg" }

# 路径定义
$NODE_DIR    = "$InstallDir\runtime\node"
$OC_BIN      = "$InstallDir\npm-global\bin\openclaw.cmd"
$MANIFEST    = "$InstallDir\manifest.json"
$LOG_FILE    = "$InstallDir\logs\gateway.log"
$CONFIG_FILE = "$InstallDir\data\openclaw.json"

# 进程级环境变量（不污染系统）
$env:PATH                 = "$NODE_DIR;$InstallDir\npm-global\bin;$env:PATH"
$env:NPM_CONFIG_PREFIX    = "$InstallDir\npm-global"
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

    # 如果已经在运行，直接返回
    if (Test-GatewayHealth) {
        Log-OK "Gateway 已在运行"
        Write-Output "[RESULT]already_running"
        exit 0
    }

    # 检查端口是否被占用（非 openclaw 进程）
    $portProcess = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($portProcess) {
        $procName = (Get-Process -Id $portProcess.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Log-Warn "端口 $Port 被 $procName 占用"
    }

    # 清空旧日志
    New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
    "" | Out-File $LOG_FILE -Encoding utf8

    Log-Info "可执行文件: $OC_BIN"
    Log-Info "配置文件: $CONFIG_FILE"
    Log-Info "日志文件: $LOG_FILE"

    # 启动进程（后台，日志写文件）
    $procArgs = @("gateway", "--port", $Port, "--allow-unconfigured", "--auth", "none")

    $proc = Start-Process -FilePath $OC_BIN `
        -ArgumentList $procArgs `
        -RedirectStandardOutput $LOG_FILE `
        -RedirectStandardError  $LOG_FILE `
        -PassThru -WindowStyle Hidden

    Write-PID $proc.Id
    Log-OK "Gateway 进程已创建（PID: $($proc.Id)）"

    # 监控启动（最多 60s，流式输出日志）
    $deadline = (Get-Date).AddSeconds(60)
    $lastLineCount = 0
    $started = $false

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500

        # 流式输出新增日志行
        if (Test-Path $LOG_FILE) {
            $lines = Get-Content $LOG_FILE
            if ($lines.Count -gt $lastLineCount) {
                $newLines = $lines[$lastLineCount..($lines.Count - 1)]
                foreach ($line in $newLines) {
                    if ($line.Trim() -ne "") { Log-Dim $line }
                }
                $lastLineCount = $lines.Count
            }

            # 关键词检测
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

        # HTTP 健康检查
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

    # 先尝试通过 openclaw gateway stop 优雅停止
    try {
        & $OC_BIN "gateway" "stop" 2>&1 | Out-Null
        Start-Sleep -Milliseconds 800
        if (-not (Test-GatewayHealth)) {
            $stopped = $true
            Log-OK "Gateway 已优雅停止"
        }
    } catch {}

    # 如果还在运行，通过 PID 强制停止
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

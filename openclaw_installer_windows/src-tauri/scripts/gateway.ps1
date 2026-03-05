# OpenClaw Gateway 进程管理脚本（简化版：使用系统 PATH 中的 openclaw）
# 参数通过环境变量传入（由 Tauri 注入）
$Action     = if ($env:GW_ACTION)      { $env:GW_ACTION }      else { "status" }
$InstallDir = if ($env:GW_INSTALL_DIR) { $env:GW_INSTALL_DIR } else { "C:\OpenClaw" }
$Port       = if ($env:GW_PORT)        { [int]$env:GW_PORT }   else { 18789 }

$ErrorActionPreference = "Continue"

function Log-Info  { param($msg) Write-Output "[INFO] $msg" }
function Log-OK    { param($msg) Write-Output "[OK] $msg" }
function Log-Warn  { param($msg) Write-Output "[WARN] $msg" }
function Log-Error { param($msg) Write-Output "[ERROR] $msg" }
function Log-Dim   { param($msg) Write-Output "[DIM] $msg" }

# 刷新 PATH：从注册表读取最新值（安装 openclaw 后 Tauri 进程的旧 PATH 可能缺少 npm bin）
function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Refresh-Path

# 路径与配置（openclaw 从系统 PATH 调用，仅需指定配置目录）
$MANIFEST    = "$InstallDir\manifest.json"
$STDOUT_LOG  = "$InstallDir\logs\gateway-stdout.log"
$STDERR_LOG  = "$InstallDir\logs\gateway-stderr.log"
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

# ── 辅助：查找 openclaw 可执行文件 ─────────────────────────────────────────

function Find-OpenClaw {
    $exe = (Get-Command "openclaw" -ErrorAction SilentlyContinue).Source
    if ($exe -and (Test-Path $exe)) { return $exe }

    $exe = (Get-Command "openclaw.cmd" -ErrorAction SilentlyContinue).Source
    if ($exe -and (Test-Path $exe)) { return $exe }

    try {
        $npmPrefix = (& npm config get prefix 2>&1).Trim()
        if ($npmPrefix) {
            $candidate = "$npmPrefix\openclaw.cmd"
            if (Test-Path $candidate) { return $candidate }
            $candidate = "$npmPrefix\openclaw"
            if (Test-Path $candidate) { return $candidate }
        }
    } catch {}

    $appDataNpm = "$env:APPDATA\npm\openclaw.cmd"
    if (Test-Path $appDataNpm) { return $appDataNpm }

    return $null
}

# ── 启动 ─────────────────────────────────────────────────────────────────

if ($Action -eq "start") {
    Log-Info "启动 Gateway（端口 $Port）..."
    Log-Info "安装目录: $InstallDir"

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

    Log-Info "配置文件: $CONFIG_FILE"
    Log-Info "查找 openclaw 可执行文件..."

    $ocExe = Find-OpenClaw
    if (-not $ocExe) {
        Log-Error "找不到 openclaw 命令"
        Log-Error "已搜索: PATH、npm prefix、$env:APPDATA\npm\"
        Log-Error "当前 PATH: $env:PATH"
        Log-Error "请确认已完成安装步骤（npm install -g openclaw）"
        Write-Output "[RESULT]failed"
        exit 1
    }
    Log-OK "openclaw 路径: $ocExe"

    $procArgs = @("gateway", "--port", $Port, "--allow-unconfigured", "--auth", "none")
    Log-Info "启动命令: $ocExe $($procArgs -join ' ')"

    try {
        $proc = Start-Process -FilePath $ocExe `
            -ArgumentList $procArgs `
            -RedirectStandardOutput $STDOUT_LOG `
            -RedirectStandardError  $STDERR_LOG `
            -PassThru -WindowStyle Hidden
    } catch {
        Log-Error "Start-Process 异常: $_"
        Write-Output "[RESULT]failed"
        exit 1
    }

    if (-not $proc -or -not $proc.Id) {
        Log-Error "无法启动 openclaw 进程（Start-Process 返回空）"
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

        # 读取 stdout 日志
        if (Test-Path $STDOUT_LOG) {
            $lines = @(Get-Content $STDOUT_LOG -ErrorAction SilentlyContinue)
            if ($lines.Count -gt $lastLineCount) {
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
            if ($logContent -match "unhandledpromiserejection|eaddrinuse|cannot find module") {
                Log-Error "Gateway 启动失败，检测到错误关键词"
                break
            }
        }

        # 读取 stderr 日志（可能有有用的错误信息）
        if (Test-Path $STDERR_LOG) {
            $errLines = @(Get-Content $STDERR_LOG -ErrorAction SilentlyContinue)
            $errText = ($errLines -join " ").ToLower()
            if ($errText -match "error|cannot find module|eaddrinuse") {
                foreach ($line in $errLines) {
                    if ($line.Trim() -ne "") { Log-Error $line }
                }
                Log-Error "Gateway stderr 报错，中止等待"
                break
            }
        }

        # 进程是否已退出
        if ($proc.HasExited) {
            Log-Error "openclaw 进程已退出（退出码: $($proc.ExitCode)）"
            if (Test-Path $STDERR_LOG) {
                $errContent = Get-Content $STDERR_LOG -ErrorAction SilentlyContinue
                foreach ($line in $errContent) {
                    if ($line.Trim() -ne "") { Log-Error $line }
                }
            }
            break
        }

        if (Test-GatewayHealth) {
            $started = $true
            break
        }
    }

    if ($started) {
        Log-OK "Gateway 已就绪 -> http://localhost:$Port"
        Write-Output "[RESULT]started:$($proc.Id)"
    } else {
        Log-Error "Gateway 未能在 60 秒内就绪"
        Log-Error "stdout 日志: $STDOUT_LOG"
        Log-Error "stderr 日志: $STDERR_LOG"
        Write-Output "[RESULT]failed"
        exit 1
    }
}

# ── 停止 ─────────────────────────────────────────────────────────────────

elseif ($Action -eq "stop") {
    $m = Read-Manifest
    $stopped = $false

    try {
        $ocStop = Find-OpenClaw
        if ($ocStop) { & $ocStop gateway stop 2>&1 | Out-Null }
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

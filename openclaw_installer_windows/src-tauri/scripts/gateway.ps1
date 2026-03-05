# OpenClaw Gateway 管理脚本
# 参数通过环境变量传入（由 Tauri 注入）
$Action     = if ($env:GW_ACTION)      { $env:GW_ACTION }      else { "status" }
$InstallDir = if ($env:GW_INSTALL_DIR) { $env:GW_INSTALL_DIR } else { "C:\OpenClaw" }
$Port       = if ($env:GW_PORT)        { [int]$env:GW_PORT }   else { 18789 }

$ErrorActionPreference = "Continue"

$_dbgLog = "d:\CODE\openclawInstaller\openclaw_installer_windows\.cursor\debug.log"
function Dbg { param($loc,$msg,$data) try { $ts=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $j=@{location=$loc;message=$msg;data=$data;timestamp=$ts;runId='ps-gateway';hypothesisId='GW'}|ConvertTo-Json -Compress; Add-Content -Path $_dbgLog -Value $j -Encoding utf8 } catch {} }

Dbg "gateway.ps1:entry" "script entered" @{Action=$Action;InstallDir=$InstallDir;Port=$Port}

function Log-Info  { param($msg) Write-Output "[INFO] $msg" }
function Log-OK    { param($msg) Write-Output "[OK] $msg" }
function Log-Warn  { param($msg) Write-Output "[WARN] $msg" }
function Log-Error { param($msg) Write-Output "[ERROR] $msg" }
function Log-Dim   { param($msg) Write-Output "[DIM] $msg" }

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

function Test-GatewayHealth {
    try {
        $r = Invoke-WebRequest "http://localhost:$Port/health" -TimeoutSec 2 -UseBasicParsing
        return $r.StatusCode -lt 500
    } catch { return $false }
}

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

function Read-Manifest {
    if (Test-Path "$InstallDir\manifest.json") {
        try { return Get-Content "$InstallDir\manifest.json" -Raw | ConvertFrom-Json } catch {}
    }
    return $null
}

function Write-PID { param($pid_val)
    $m = Read-Manifest
    if ($m) {
        $m.gateway_pid = $pid_val
        $m | ConvertTo-Json -Depth 10 | Out-File "$InstallDir\manifest.json" -Encoding utf8
    }
}

# ── 全局 try/catch：确保任何异常都能输出到 stdout（前端可见）─────────────
try {

Refresh-Path
Dbg "gateway.ps1:path-refreshed" "PATH refreshed" @{PATH_len=$env:PATH.Length}

# ── 启动 ─────────────────────────────────────────────────────────────
if ($Action -eq "start") {
    Log-Info "gateway.ps1 starting (port=$Port, dir=$InstallDir)"

    if (Test-GatewayHealth) {
        Log-OK "Gateway already running"
        Write-Output "[RESULT]already_running"
        exit 0
    }

    Dbg "gateway.ps1:health-checked" "health check done, not running" @{}

    New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null

    Log-Info "Searching for openclaw executable..."
    $ocExe = Find-OpenClaw
    Dbg "gateway.ps1:find-oc" "Find-OpenClaw result" @{ocExe="$ocExe"}

    if (-not $ocExe) {
        Log-Error "Cannot find openclaw command"
        Log-Error "Searched: PATH, npm prefix, $env:APPDATA\npm\"
        Dbg "gateway.ps1:oc-not-found" "openclaw not found" @{PATH=$env:PATH}
        Write-Output "[RESULT]failed"
        exit 1
    }
    Log-OK "openclaw found: $ocExe"

    $STDOUT_LOG = "$InstallDir\logs\gateway-stdout.log"
    $STDERR_LOG = "$InstallDir\logs\gateway-stderr.log"
    "" | Out-File $STDOUT_LOG -Encoding utf8 -Force
    "" | Out-File $STDERR_LOG -Encoding utf8 -Force

    $CONFIG_FILE = "$InstallDir\data\openclaw.json"
    $env:OPENCLAW_CONFIG_PATH = $CONFIG_FILE
    $env:OPENCLAW_HOME = "$InstallDir\data"

    # .cmd 文件需要通过 cmd.exe 启动，否则 Start-Process + Redirect 可能失败
    $isCmdFile = $ocExe.EndsWith(".cmd")
    if ($isCmdFile) {
        $startExe = "cmd.exe"
        $startArgs = @("/c", "`"$ocExe`"", "gateway", "--port", "$Port", "--allow-unconfigured", "--auth", "none")
    } else {
        $startExe = $ocExe
        $startArgs = @("gateway", "--port", "$Port", "--allow-unconfigured", "--auth", "none")
    }

    Log-Info "Launch: $startExe $($startArgs -join ' ')"
    Dbg "gateway.ps1:pre-start" "about to Start-Process" @{exe=$startExe;args=($startArgs -join ' ');isCmdFile=$isCmdFile}

    try {
        $proc = Start-Process -FilePath $startExe `
            -ArgumentList $startArgs `
            -RedirectStandardOutput $STDOUT_LOG `
            -RedirectStandardError  $STDERR_LOG `
            -PassThru -WindowStyle Hidden
    } catch {
        $errMsg = $_.Exception.Message
        Log-Error "Start-Process failed: $errMsg"
        Dbg "gateway.ps1:start-process-fail" "Start-Process exception" @{error=$errMsg}
        Write-Output "[RESULT]failed"
        exit 1
    }

    if (-not $proc -or -not $proc.Id) {
        Log-Error "Start-Process returned null"
        Dbg "gateway.ps1:proc-null" "proc is null after Start-Process" @{}
        Write-Output "[RESULT]failed"
        exit 1
    }

    Write-PID $proc.Id
    Log-OK "Process started (PID: $($proc.Id))"
    Dbg "gateway.ps1:proc-started" "process created" @{pid=$proc.Id}

    $deadline = (Get-Date).AddSeconds(60)
    $lastLineCount = 0
    $started = $false

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 800

        if ($proc.HasExited) {
            Log-Error "openclaw exited early (code: $($proc.ExitCode))"
            if (Test-Path $STDERR_LOG) {
                $errContent = @(Get-Content $STDERR_LOG -ErrorAction SilentlyContinue)
                foreach ($line in $errContent) {
                    if ($line.Trim() -ne "") { Log-Error "  stderr: $line" }
                }
            }
            if (Test-Path $STDOUT_LOG) {
                $outContent = @(Get-Content $STDOUT_LOG -ErrorAction SilentlyContinue)
                foreach ($line in $outContent) {
                    if ($line.Trim() -ne "") { Log-Dim "  stdout: $line" }
                }
            }
            Dbg "gateway.ps1:proc-exited" "process exited early" @{exitCode=$proc.ExitCode}
            break
        }

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
        }

        if (Test-GatewayHealth) {
            $started = $true
            break
        }
    }

    if ($started) {
        Log-OK "Gateway ready -> http://localhost:$Port"
        Dbg "gateway.ps1:ready" "gateway is ready" @{port=$Port;pid=$proc.Id}
        Write-Output "[RESULT]started:$($proc.Id)"
    } else {
        Log-Error "Gateway did not become ready within 60s"
        Log-Error "stdout log: $STDOUT_LOG"
        Log-Error "stderr log: $STDERR_LOG"
        Dbg "gateway.ps1:timeout" "gateway timeout" @{}
        Write-Output "[RESULT]failed"
        exit 1
    }
}

# ── 停止 ─────────────────────────────────────────────────────────────
elseif ($Action -eq "stop") {
    $stopped = $false
    try {
        $ocStop = Find-OpenClaw
        if ($ocStop) { & $ocStop gateway stop 2>&1 | Out-Null }
        Start-Sleep -Milliseconds 800
        if (-not (Test-GatewayHealth)) {
            $stopped = $true
            Log-OK "Gateway stopped gracefully"
        }
    } catch {}

    if (-not $stopped) {
        $m = Read-Manifest
        if ($m -and $m.gateway_pid) {
            Stop-Process -Id $m.gateway_pid -Force -ErrorAction SilentlyContinue
            Log-OK "Gateway process killed (PID: $($m.gateway_pid))"
            Write-PID $null
        }
    }
    Write-Output "[RESULT]stopped"
}

# ── 状态 ─────────────────────────────────────────────────────────────
elseif ($Action -eq "status") {
    if (Test-GatewayHealth) { Write-Output "running" } else { Write-Output "stopped" }
}

} catch {
    $errMsg = $_.Exception.Message
    $errPos = $_.InvocationInfo.PositionMessage
    Log-Error "UNHANDLED EXCEPTION: $errMsg"
    Log-Error "Position: $errPos"
    Dbg "gateway.ps1:unhandled" "unhandled exception" @{error=$errMsg;position=$errPos}
    Write-Output "[RESULT]failed"
    exit 1
}

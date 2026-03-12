# OpenClaw Gateway script
# Params via env vars (injected by Tauri)
$Action     = if ($env:GW_ACTION)      { $env:GW_ACTION }      else { "status" }
$InstallDir = if ($env:GW_INSTALL_DIR) { $env:GW_INSTALL_DIR } else { "C:\OpenClaw" }
$Port       = if ($env:GW_PORT)        { [int]$env:GW_PORT }   else { 18789 }

$ErrorActionPreference = "Continue"

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
    # Prefer .cmd (Start-Process can run it directly)
    $cmd = (Get-Command "openclaw.cmd" -ErrorAction SilentlyContinue).Source
    if ($cmd -and (Test-Path $cmd)) { return $cmd }

    # If Get-Command returns .ps1, resolve .cmd in same dir
    $any = (Get-Command "openclaw" -ErrorAction SilentlyContinue).Source
    if ($any) {
        $dir = Split-Path $any -Parent
        $cmdInDir = Join-Path $dir "openclaw.cmd"
        if (Test-Path $cmdInDir) { return $cmdInDir }
    }

    # npm prefix fallback
    try {
        $npmPrefix = (& npm config get prefix 2>&1).Trim()
        if ($npmPrefix) {
            $candidate = "$npmPrefix\openclaw.cmd"
            if (Test-Path $candidate) { return $candidate }
        }
    } catch {}

    # %APPDATA%\npm fallback
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

# ── Global try/catch: ensure errors go to stdout (visible to frontend) ─────────
try {

Refresh-Path

# ── Start ────────────────────────────────────────────────────────────
if ($Action -eq "start") {
    Log-Info "gateway.ps1 starting (port=$Port, dir=$InstallDir)"

    if (Test-GatewayHealth) {
        Log-OK "Gateway already running"
        Write-Output "[RESULT]already_running"
        exit 0
    }


    New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null

    Log-Info "Searching for openclaw executable..."
    $ocExe = Find-OpenClaw

    if (-not $ocExe) {
        Log-Error "Cannot find openclaw command"
        Log-Error "Searched: PATH, npm prefix, $env:APPDATA\npm\"
        Write-Output "[RESULT]failed"
        exit 1
    }
    Log-OK "openclaw found: $ocExe"

    $STDOUT_LOG = "$InstallDir\logs\gateway-stdout.log"
    $STDERR_LOG = "$InstallDir\logs\gateway-stderr.log"
    "" | Out-File $STDOUT_LOG -Encoding utf8 -Force
    "" | Out-File $STDERR_LOG -Encoding utf8 -Force

    # Use OpenClaw default config dir (~/.openclaw)

    # .cmd must be run via cmd.exe or Start-Process redirect may fail
    $isCmdFile = $ocExe.EndsWith(".cmd")
    if ($isCmdFile) {
        $startExe = "cmd.exe"
        $startArgs = @("/c", "`"$ocExe`"", "gateway", "--port", "$Port", "--allow-unconfigured")
    } else {
        $startExe = $ocExe
        $startArgs = @("gateway", "--port", "$Port", "--allow-unconfigured")
    }

    Log-Info "Launch: $startExe $($startArgs -join ' ')"

    try {
        $proc = Start-Process -FilePath $startExe `
            -ArgumentList $startArgs `
            -RedirectStandardOutput $STDOUT_LOG `
            -RedirectStandardError  $STDERR_LOG `
            -PassThru -WindowStyle Hidden
    } catch {
        $errMsg = $_.Exception.Message
        Log-Error "Start-Process failed: $errMsg"
        Write-Output "[RESULT]failed"
        exit 1
    }

    if (-not $proc -or -not $proc.Id) {
        Log-Error "Start-Process returned null"
        Write-Output "[RESULT]failed"
        exit 1
    }

    Write-PID $proc.Id
    Log-OK "Process started (PID: $($proc.Id))"

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
        Write-Output "[RESULT]started:$($proc.Id)"
    } else {
        Log-Error "Gateway did not become ready within 60s"
        Log-Error "stdout log: $STDOUT_LOG"
        Log-Error "stderr log: $STDERR_LOG"
        Write-Output "[RESULT]failed"
        exit 1
    }
}

# ── Stop ─────────────────────────────────────────────────────────────
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

# ── Status ───────────────────────────────────────────────────────────
elseif ($Action -eq "status") {
    if (Test-GatewayHealth) { Write-Output "running" } else { Write-Output "stopped" }
}

} catch {
    $errMsg = $_.Exception.Message
    $errPos = $_.InvocationInfo.PositionMessage
    Log-Error "UNHANDLED EXCEPTION: $errMsg"
    Log-Error "Position: $errPos"
    Write-Output "[RESULT]failed"
    exit 1
}


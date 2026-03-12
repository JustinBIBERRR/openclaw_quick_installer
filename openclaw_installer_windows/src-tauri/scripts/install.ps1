$ErrorActionPreference = "Continue"

$ResultFile = $env:OPENCLAW_RESULT_FILE
$ProgressFile = $env:OPENCLAW_PROGRESS_FILE
$InstallDir = if ($env:OPENCLAW_INSTALL_DIR) { $env:OPENCLAW_INSTALL_DIR } else { "$env:USERPROFILE\OpenClaw" }

# ── Log helpers ───────────────────────────────────────────────────────────────
$_logDir  = "$InstallDir\logs"
$_logFile = "$_logDir\install-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
$_t0      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function Write-Log {
    param([string]$Level, [string]$Msg)
    $ts  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $elapsed = [math]::Round(($ts - $_t0) / 1000, 1)
    $line = "[{0:s}Z +{1}s] [{2}] {3}" -f [datetime]::UtcNow, $elapsed, $Level.ToUpper(), $Msg
    try {
        if (-not (Test-Path $_logDir)) { New-Item -ItemType Directory -Force -Path $_logDir | Out-Null }
        Add-Content -Path $_logFile -Value $line -Encoding utf8
    } catch {}
    switch ($Level.ToLower()) {
        "ok"    { Write-Host "[OK]    $Msg" -ForegroundColor Green }
        "warn"  { Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
        "error" { Write-Host "[ERROR] $Msg" -ForegroundColor Red }
        "step"  { Write-Host "`n=== $Msg ===" -ForegroundColor Cyan }
        default { Write-Host "[INFO]  $Msg" }
    }
}

function Step {
    param($n, $msg)
    Write-Log "step" "[$n] $msg"
}

function LogOk   { param($msg) Write-Log "ok"    $msg }
function LogInfo { param($msg) Write-Log "info"  $msg }
function LogWarn { param($msg) Write-Log "warn"  $msg }

function Write-Progress-File {
    param([int]$Step, [int]$Total, [string]$Label)
    if ($ProgressFile) {
        try {
            [System.IO.File]::WriteAllText($ProgressFile, "$Step/$Total $Label", [System.Text.Encoding]::ASCII)
        } catch {}
    }
}

function Get-ScriptSleepSeconds {
    param([int]$normalSeconds)
    if ($env:OPENCLAW_TEST_MODE -eq "1") { return 0 }
    return $normalSeconds
}

function Fail {
    param($msg)
    Write-Log "error" $msg
    if ($ResultFile) {
        [System.IO.File]::WriteAllText($ResultFile, "error:$msg", [System.Text.Encoding]::ASCII)
    }
    Write-Host ""
    Write-Host "Installation failed. This window will close in 10 seconds. Full log:" -ForegroundColor Yellow
    Write-Host "  $_logFile" -ForegroundColor Gray
    Start-Sleep -Seconds (Get-ScriptSleepSeconds 10)
    exit 1
}

function Update-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

# ── Startup ────────────────────────────────────────────────────────────────────
Write-Log "info" "OpenClaw install script started | InstallDir=$InstallDir | ResultFile=$ResultFile"

try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    New-Item -ItemType Directory -Force -Path $_logDir   | Out-Null
} catch {
    Fail "Failed to create install directory: $_"
}

# ── Phase 1: Node.js ───────────────────────────────────────────────────────────
Write-Progress-File -Step 1 -Total 4 -Label "detectingNode"
Step "1/3" "Checking Node.js runtime"
$_t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$nodeReady = $false
try {
    $nodeVersion = & node --version 2>&1
    if ($LASTEXITCODE -eq 0 -and $nodeVersion -match "v(\d+)\." -and [int]$Matches[1] -ge 18) {
        $nodeReady = $true
        Write-Log "info" "Node.js found: $nodeVersion"
        LogOk "Node.js detected: $nodeVersion"
        Write-Progress-File -Step 1 -Total 4 -Label "nodeReady"
    } else {
        Write-Log "info" "node --version output: $nodeVersion (version too old or not installed)"
    }
} catch {
    Write-Log "info" "Node check exception: $_"
}

if (-not $nodeReady) {
    Write-Progress-File -Step 1 -Total 4 -Label "installingNode"
    LogInfo "Node.js 18+ not found. Installing Node.js LTS via winget..."
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
    $wingetNodeExit = $LASTEXITCODE
    Write-Log "info" "winget install Node.js exit code: $wingetNodeExit | elapsed: $([math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$_t1)/1000,1))s"
    if ($wingetNodeExit -ne 0) {
        Fail "Node.js installation failed (winget exit code $wingetNodeExit). Please install Node.js 18+ manually and retry."
    }
    Update-Path
    $nodeVersion = & node --version 2>&1
    Write-Log "info" "node version after install: $nodeVersion"
    LogOk "Node.js installed: $nodeVersion"
    Write-Progress-File -Step 1 -Total 4 -Label "nodeReady"
}

# ── Phase 2: OpenClaw CLI ──────────────────────────────────────────────────────
Write-Progress-File -Step 2 -Total 4 -Label "connectingNpm"
Step "2/3" "Checking / Installing OpenClaw"
$_t2 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Update-Path

$existingOcVer = $null
$openclawAlreadyInstalled = $false
try {
    $existingOcCmd = Get-Command openclaw -ErrorAction SilentlyContinue
    if (-not $existingOcCmd) { $existingOcCmd = Get-Command openclaw.cmd -ErrorAction SilentlyContinue }
    if ($existingOcCmd) {
        $existingOcVer = & $existingOcCmd.Source --version 2>&1
        if ($LASTEXITCODE -eq 0 -and "$existingOcVer".Trim()) {
            Write-Log "info" "OpenClaw already installed: $existingOcVer | path: $($existingOcCmd.Source)"
            LogOk "OpenClaw found, skipping install"
            $openclawAlreadyInstalled = $true
            Write-Progress-File -Step 2 -Total 4 -Label "cliReady"
        } else {
            $existingOcVer = $null
        }
    }
} catch {
    Write-Log "warn" "openclaw --version check failed, continuing install: $_"
    $existingOcVer = $null
}

if (-not $existingOcVer) {
    Write-Progress-File -Step 2 -Total 4 -Label "downloadingCli"
    LogInfo "Running: npm install -g openclaw@latest"
    LogInfo "(Install may take 1-2 minutes, npm output below)"
    Write-Host ""
    Write-Progress-File -Step 2 -Total 4 -Label "installingCli"
    npm install -g openclaw@latest
    $ocInstallExit = $LASTEXITCODE
    Write-Host ""
    Write-Log "info" "npm install -g openclaw@latest exit code: $ocInstallExit | elapsed: $([math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$_t2)/1000,1))s"
    if ($ocInstallExit -ne 0) {
        Fail "npm install -g openclaw@latest failed (exit code $ocInstallExit)"
    }
    Write-Progress-File -Step 2 -Total 4 -Label "cliReady"
}

# ── Phase 3: Verify ──────────────────────────────────────────────────────────
Write-Progress-File -Step 3 -Total 4 -Label "verifyingInstall"
Step "3/3" "Verifying installation"
Update-Path
$ocVer = $null
$ocCmd = Get-Command openclaw -ErrorAction SilentlyContinue
if (-not $ocCmd) { $ocCmd = Get-Command openclaw.cmd -ErrorAction SilentlyContinue }
if ($ocCmd) {
    $ocVer = & $ocCmd.Source --version 2>&1
    Write-Log "info" "openclaw path: $($ocCmd.Source) | version: $ocVer"
} else {
    $candidates = @(
        "$env:APPDATA\npm\openclaw.cmd",
        "$env:USERPROFILE\.openclaw\bin\openclaw"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $ocVer = & $c --version 2>&1
            Write-Log "info" "openclaw candidate path: $c | version: $ocVer"
            break
        }
    }
}
if (-not $ocVer) {
    Fail "openclaw command not found. Install may have failed. Reopen terminal and run openclaw --version to confirm."
}
LogOk "openclaw version: $ocVer"

# ── Write install info ────────────────────────────────────────────────────────
Write-Progress-File -Step 3 -Total 4 -Label "writingConfig"
$totalSec = [math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $_t0) / 1000, 1)
Write-Log "info" "Install complete | total elapsed: ${totalSec}s | log: $_logFile"

$installInfo = @{
    install_dir  = $InstallDir
    port         = 18789
    installed_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
    log_file     = $_logFile
    total_sec    = $totalSec
    oc_version   = "$ocVer"
    existing_openclaw = $openclawAlreadyInstalled
} | ConvertTo-Json
$installInfo | Out-File "$InstallDir\install-info.json" -Encoding utf8

Write-Progress-File -Step 4 -Total 4 -Label "allDone"
if ($ResultFile) {
    [System.IO.File]::WriteAllText($ResultFile, "install_ok", [System.Text.Encoding]::ASCII)
}
LogOk "Installation complete. Total ${totalSec}s. This window will close in 3 seconds..."
LogInfo "Full log saved to: $_logFile"
Start-Sleep -Seconds (Get-ScriptSleepSeconds 3)

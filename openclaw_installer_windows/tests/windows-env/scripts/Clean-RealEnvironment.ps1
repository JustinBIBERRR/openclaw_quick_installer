param(
    [switch]$Force,
    [switch]$KeepNpmPackage
)

$ErrorActionPreference = "Stop"

Write-Host "=== OpenClaw Real Environment Cleanup ===" -ForegroundColor Cyan
Write-Host ""

if (-not $Force) {
    Write-Host "This script will clean:" -ForegroundColor Yellow
    Write-Host "  1. Stop OpenClaw-related processes" -ForegroundColor Yellow
    Write-Host "  2. Remove $env:USERPROFILE\.openclaw" -ForegroundColor Yellow
    if (-not $KeepNpmPackage) {
        Write-Host "  3. Uninstall global npm package openclaw" -ForegroundColor Yellow
    }
    Write-Host ""
    $confirm = Read-Host "Type YES to continue"
    if ($confirm -ne "YES") {
        Write-Host "Cancelled." -ForegroundColor Red
        exit 0
    }
}

Write-Host ""
Write-Host "[1/4] Checking OpenClaw processes..." -ForegroundColor Green

$processes = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.ProcessName -like "*openclaw*") -or ($_.ProcessName -like "*gateway*")
}

if ($processes) {
    foreach ($proc in $processes) {
        Write-Host ("  - PID: {0}, Name: {1}" -f $proc.Id, $proc.ProcessName) -ForegroundColor Yellow
    }
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "Processes stopped." -ForegroundColor Green
}
else {
    Write-Host "No OpenClaw process found." -ForegroundColor Green
}

Write-Host ""
Write-Host "[2/4] Cleaning config directory..." -ForegroundColor Green

$openclawDir = Join-Path $env:USERPROFILE ".openclaw"
$openclawExistsBefore = Test-Path $openclawDir

if ($openclawExistsBefore) {
    try {
        Remove-Item -Path $openclawDir -Recurse -Force -ErrorAction Stop
        Write-Host ("Removed: {0}" -f $openclawDir) -ForegroundColor Green
    }
    catch {
        Write-Host ("Failed to remove: {0}" -f $openclawDir) -ForegroundColor Red
        Write-Host ("  Reason: {0}" -f $_.Exception.Message) -ForegroundColor Red
        Write-Host "  Tip: Close Explorer/IDE windows that have this folder open, or run PowerShell as Administrator." -ForegroundColor Yellow
    }
}
else {
    Write-Host "Config directory not found." -ForegroundColor Green
}

Write-Host ""
Write-Host "[3/4] Cleaning global npm package..." -ForegroundColor Green

if (-not $KeepNpmPackage) {
    $npmAvailable = Get-Command npm -ErrorAction SilentlyContinue

    if ($npmAvailable) {
        $npmList = npm list -g openclaw --depth=0 2>&1 | Out-String
        if ($npmList -match "openclaw@") {
            npm uninstall -g openclaw 2>&1 | Out-Null
            Write-Host "Global npm package openclaw removed." -ForegroundColor Green
        }
        else {
            Write-Host "Global npm package openclaw not installed." -ForegroundColor Green
        }
    }
    else {
        Write-Host "npm not available; skip npm cleanup." -ForegroundColor Yellow
    }
}
else {
    Write-Host "Skip npm cleanup due to -KeepNpmPackage." -ForegroundColor Cyan
}

Write-Host ""
Write-Host "[4/4] Verifying cleanup..." -ForegroundColor Green

$allClean = $true

if (Test-Path $openclawDir) {
    $allClean = $false
    Write-Host ("Still exists: {0}" -f $openclawDir) -ForegroundColor Red
}
else {
    Write-Host "Config directory is clean." -ForegroundColor Green
}

$remainingProcesses = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.ProcessName -like "*openclaw*") -or ($_.ProcessName -like "*gateway*")
}

if ($remainingProcesses) {
    $allClean = $false
    Write-Host "Some OpenClaw-related processes are still running." -ForegroundColor Red
}
else {
    Write-Host "No OpenClaw-related process is running." -ForegroundColor Green
}

Write-Host ""
if ($allClean) {
    Write-Host "Cleanup complete: environment is OpenClaw-free." -ForegroundColor Green
}
else {
    Write-Host "Cleanup finished with warnings; check output above." -ForegroundColor Yellow
}

param(
    [switch]$KeepNpmPackage
)

$ErrorActionPreference = "Stop"

Write-Host "=== OpenClaw Cleanup Helper ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "This script will clean current user OpenClaw environment." -ForegroundColor Yellow
Write-Host ""

$processes = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.ProcessName -like "*openclaw*") -or ($_.ProcessName -like "*gateway*")
}
if ($processes) {
    Write-Host "[1/3] Stopping related processes..." -ForegroundColor Green
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "[1/3] No running OpenClaw process found." -ForegroundColor Green
}

$openclawDir = Join-Path $env:USERPROFILE ".openclaw"
if (Test-Path $openclawDir) {
    Write-Host "[2/3] Removing $openclawDir ..." -ForegroundColor Green
    Remove-Item -Path $openclawDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "[2/3] Config directory not found." -ForegroundColor Green
}

if (-not $KeepNpmPackage) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($npm) {
        Write-Host "[3/3] Uninstalling global npm package openclaw..." -ForegroundColor Green
        npm uninstall -g openclaw 2>&1 | Out-Null
    } else {
        Write-Host "[3/3] npm is unavailable, skip package cleanup." -ForegroundColor Yellow
    }
} else {
    Write-Host "[3/3] Skip npm package cleanup." -ForegroundColor Yellow
}

Write-Host ""
if (Test-Path $openclawDir) {
    Write-Host "Cleanup finished with warnings: $openclawDir still exists." -ForegroundColor Yellow
} else {
    Write-Host "Cleanup completed. OpenClaw user environment has been removed." -ForegroundColor Green
}
Write-Host ""
Write-Host "You can close this window now."

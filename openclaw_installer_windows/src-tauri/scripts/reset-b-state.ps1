# reset-b-state.ps1
# Resets local env to "B-state": Node.js kept, OpenClaw CLI/config/Gateway removed.
# Run in an elevated PowerShell:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ".\src-tauri\scripts\reset-b-state.ps1"

$ErrorActionPreference = "Continue"

Write-Host "[INFO] =============================" -ForegroundColor Cyan
Write-Host "[INFO]  B-State Reset  (keep Node.js)" -ForegroundColor Cyan
Write-Host "[INFO] =============================" -ForegroundColor Cyan

# ---- STEP 1: stop gateway service ----
Write-Host "`n[STEP 1] Stop gateway service..." -ForegroundColor Yellow
$ocCmd = $null
$oc1 = Get-Command "openclaw.cmd" -ErrorAction SilentlyContinue
$oc2 = Get-Command "openclaw" -ErrorAction SilentlyContinue
if ($oc1) { $ocCmd = $oc1.Source }
elseif ($oc2) { $ocCmd = $oc2.Source }

if ($ocCmd) {
    Write-Host "[INFO] Found openclaw at: $ocCmd" -ForegroundColor Gray
    Write-Host "[INFO] Running: openclaw gateway stop" -ForegroundColor Gray
    & cmd.exe /c "`"$ocCmd`"" gateway stop 2>&1 | Out-Null
    Start-Sleep -Seconds 1
    Write-Host "[INFO] Running: openclaw gateway uninstall" -ForegroundColor Gray
    & cmd.exe /c "`"$ocCmd`"" gateway uninstall 2>&1 | Out-Null
    Start-Sleep -Seconds 1
    Write-Host "[OK]   Gateway service handled" -ForegroundColor Green
} else {
    Write-Host "[SKIP] openclaw command not found, skipping gateway stop/uninstall" -ForegroundColor DarkGray
}

# ---- STEP 2: kill process on port 18789 ----
Write-Host "`n[STEP 2] Kill processes on port 18789..." -ForegroundColor Yellow
$netConns = Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue
if ($netConns) {
    $pids = $netConns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $pids) {
        if ($p -and $p -gt 0) {
            Write-Host "[INFO] Killing PID=$p" -ForegroundColor Gray
            & taskkill /PID $p /F /T 2>&1 | Out-Null
        }
    }
    Write-Host "[OK]   Port 18789 cleared" -ForegroundColor Green
} else {
    Write-Host "[SKIP] No active process on port 18789" -ForegroundColor DarkGray
}

# ---- STEP 3: delete files/directories ----
Write-Host "`n[STEP 3] Delete OpenClaw files..." -ForegroundColor Yellow

function Remove-IfExists {
    param([string]$Target)
    if (Test-Path -LiteralPath $Target) {
        try {
            Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction Stop
            Write-Host "[OK]   Deleted: $Target" -ForegroundColor Green
        } catch {
            Write-Host "[WARN] Failed to delete: $Target  -- $_" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[SKIP] Not found: $Target" -ForegroundColor DarkGray
    }
}

Remove-IfExists "$env:USERPROFILE\.openclaw"
Remove-IfExists "$env:LOCALAPPDATA\OpenClaw"
Remove-IfExists "C:\OpenClaw\data"
Remove-IfExists "C:\OpenClaw\data\.openclaw"
Remove-IfExists "$env:APPDATA\npm\openclaw"
Remove-IfExists "$env:APPDATA\npm\openclaw.cmd"
Remove-IfExists "$env:APPDATA\npm\node_modules\openclaw"
Remove-IfExists "$env:USERPROFILE\Desktop\OpenClaw Manager.lnk"

# ---- STEP 4: verify ----
Write-Host "`n[STEP 4] Verify..." -ForegroundColor Yellow
$allClean = $true
$checks = @(
    "$env:USERPROFILE\.openclaw",
    "$env:LOCALAPPDATA\OpenClaw",
    "$env:APPDATA\npm\openclaw.cmd",
    "$env:APPDATA\npm\node_modules\openclaw"
)
foreach ($c in $checks) {
    if (Test-Path -LiteralPath $c) {
        Write-Host "[WARN] Still exists: $c" -ForegroundColor Yellow
        $allClean = $false
    }
}

Write-Host ""
if ($allClean) {
    Write-Host "[OK] ===== B-State reset complete. Ready for full-flow test. =====" -ForegroundColor Green
} else {
    Write-Host "[WARN] Some paths could not be removed (need admin or file in use). Clean manually." -ForegroundColor Yellow
}

# verify Node.js is still available
$nodeVer = & node --version 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Node.js intact: $nodeVer" -ForegroundColor Green
} else {
    Write-Host "[WARN] node command unavailable (unexpected)" -ForegroundColor Yellow
}

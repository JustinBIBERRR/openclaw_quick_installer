param(
    [string]$StateFile,
    [string]$RuntimeRoot,
    [switch]$Deep
)

$ErrorActionPreference = "Stop"

if (-not $RuntimeRoot) {
    $RuntimeRoot = Join-Path $PSScriptRoot "..\runtime"
}

if (-not $StateFile) {
    $runtime = Resolve-Path $RuntimeRoot -ErrorAction SilentlyContinue
    if ($runtime) {
        $StateFile = Get-ChildItem -Path $runtime -Filter "profile-state.json" -Recurse |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
}

if (-not $StateFile -or -not (Test-Path $StateFile)) {
    Write-Warning "No state file found to clean"
    return
}

$state = Get-Content -Raw -Path $StateFile -Encoding UTF8 | ConvertFrom-Json

if ($state.portBlockerPid) {
    try {
        Stop-Process -Id ([int]$state.portBlockerPid) -Force -ErrorAction Stop
    } catch {
        Write-Host "Port blocker process already exited: $($state.portBlockerPid)"
    }
}

if ($Deep -and (Test-Path $state.sessionRoot)) {
    Remove-Item -Path $state.sessionRoot -Recurse -Force
    Write-Host "Deep cleanup completed: $($state.sessionRoot)" -ForegroundColor Green
}

if ($env:USERPROFILE -eq $state.profileRoot) {
    Remove-Item Env:USERPROFILE -ErrorAction SilentlyContinue
}
if ($env:APPDATA -eq $state.appData) {
    Remove-Item Env:APPDATA -ErrorAction SilentlyContinue
}
if ($env:LOCALAPPDATA -eq $state.localAppData) {
    Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue
}
if ($env:OPENCLAW_INSTALL_DIR -eq $state.installDir) {
    Remove-Item Env:OPENCLAW_INSTALL_DIR -ErrorAction SilentlyContinue
}

Write-Host "Profile reset complete. State: $StateFile" -ForegroundColor Green

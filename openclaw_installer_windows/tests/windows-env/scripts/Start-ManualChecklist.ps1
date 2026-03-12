param(
    [Parameter(Mandatory = $true)]
    [string]$Profile,
    [string]$ExePath
)

$ErrorActionPreference = "Stop"

$prepareScript = Join-Path $PSScriptRoot "Prepare-TestProfile.ps1"
& $prepareScript -Profile $Profile | Out-Null

$runtimeRoot = Resolve-Path (Join-Path $PSScriptRoot "..\runtime")
$stateFile = Get-ChildItem -Path $runtimeRoot -Filter "profile-state.json" -Recurse |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName

$state = Get-Content -Raw -Path $stateFile -Encoding UTF8 | ConvertFrom-Json

Write-Host ""
Write-Host "=== Manual test profile is ready ===" -ForegroundColor Cyan
Write-Host "Profile: $Profile"
Write-Host "State:   $stateFile"
Write-Host "Install: $($state.installDir)"
Write-Host ""
Write-Host "Suggested manual steps:" -ForegroundColor Yellow
Write-Host "1) Launch portable exe and complete wizard steps"
Write-Host "2) Record any error code, hint, and log access behavior"
Write-Host "3) Run Run-PortableInstallerTest.ps1 to capture evidence"
Write-Host ""

if ($ExePath) {
    Write-Host "Evidence command:" -ForegroundColor Yellow
    Write-Host "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\Run-PortableInstallerTest.ps1`" -ExePath `"$ExePath`" -StateFile `"$stateFile`""
}

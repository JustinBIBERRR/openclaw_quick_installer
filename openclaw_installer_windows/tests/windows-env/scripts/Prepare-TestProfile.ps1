param(
    [Parameter(Mandatory = $true)]
    [string]$Profile,
    [string]$RuntimeRoot,
    [switch]$ApplyToCurrentSession
)

$ErrorActionPreference = "Stop"

if (-not $RuntimeRoot) {
    $RuntimeRoot = Join-Path $PSScriptRoot "..\runtime"
}

function New-CmdStub {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.Encoding]::ASCII)
}

$fixturesDir = (Resolve-Path (Join-Path $PSScriptRoot "..\fixtures")).Path
$fixturePath = Join-Path $fixturesDir "$Profile.json"
if (-not (Test-Path $fixturePath)) {
    throw "Profile not found: $Profile ($fixturePath)"
}

$fixture = Get-Content -Raw -Path $fixturePath -Encoding UTF8 | ConvertFrom-Json
$runtime = (Resolve-Path $RuntimeRoot -ErrorAction SilentlyContinue)
if (-not $runtime) {
    New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
    $runtime = Resolve-Path $RuntimeRoot
}

$sessionRoot = Join-Path $runtime.Path ("session-" + $fixture.id + "-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$binDir = Join-Path $sessionRoot "bin"
$profileRoot = if ($fixture.id -eq "ChineseUserProfile") {
    Join-Path $sessionRoot "测试用户"
} else {
    Join-Path $sessionRoot "profile"
}
$appData = Join-Path $profileRoot "AppData\Roaming"
$localAppData = Join-Path $profileRoot "AppData\Local"
$appDataNpm = Join-Path $appData "npm"
$evidenceDir = Join-Path $sessionRoot "evidence"
$statePath = Join-Path $sessionRoot "profile-state.json"

New-Item -ItemType Directory -Force -Path $sessionRoot, $binDir, $profileRoot, $appData, $localAppData, $appDataNpm, $evidenceDir | Out-Null

$nodeMode = [string]$fixture.simulate.nodeMode
$nodeFlag = Join-Path $binDir "node_ready.flag"
if ($nodeMode -eq "ready") {
    New-Item -ItemType File -Path $nodeFlag -Force | Out-Null
}

$nodeCmd = @"
@echo off
if exist "%~dp0node_ready.flag" (
  echo v22.11.0
  exit /b 0
)
if "$nodeMode"=="old16" (
  echo v16.20.0
  exit /b 0
)
echo node is not recognized as an internal or external command 1>&2
exit /b 1
"@
New-CmdStub -Path (Join-Path $binDir "node.cmd") -Content $nodeCmd

$wingetCmd = if (-not [bool]$fixture.simulate.wingetAvailable) {
    "@echo off`necho winget is blocked in this profile 1>&2`nexit /b 5`n"
} else {
    "@echo off`necho winget install success`ntype nul > ""%~dp0node_ready.flag""`nexit /b 0`n"
}
New-CmdStub -Path (Join-Path $binDir "winget.cmd") -Content $wingetCmd

$npmMode = switch ($fixture.id) {
    "NpmGlobalInstallDenied" { "permission_denied" }
    "NetworkRestricted" { "network_error" }
    "PathRefreshFailed" { "prefix_mismatch" }
    default { "ok" }
}
$npmPrefix = if ($npmMode -eq "prefix_mismatch") {
    Join-Path $profileRoot "CustomNpmPrefix"
} else {
    $appDataNpm
}
New-Item -ItemType Directory -Force -Path $npmPrefix | Out-Null

$npmCmd = @"
@echo off
set args=%*
echo %args% | findstr /I "config get prefix" >nul
if %errorlevel%==0 (
  echo $npmPrefix
  exit /b 0
)
echo %args% | findstr /I "install -g openclaw@latest" >nul
if %errorlevel%==0 (
  if "$npmMode"=="permission_denied" (
    echo npm ERR! code EPERM 1>&2
    exit /b 2
  )
  if "$npmMode"=="network_error" (
    echo npm ERR! network request failed 1>&2
    exit /b 3
  )
  if not exist "$npmPrefix" mkdir "$npmPrefix"
  > "$npmPrefix\openclaw.cmd" echo @echo off
  >> "$npmPrefix\openclaw.cmd" echo if "%%1"=="--version" echo openclaw 9.9.9
  >> "$npmPrefix\openclaw.cmd" echo exit /b 0
  echo added 1 package
  exit /b 0
)
echo npm stub executed
exit /b 0
"@
New-CmdStub -Path (Join-Path $binDir "npm.cmd") -Content $npmCmd

if ([bool]$fixture.simulate.hideGit) {
    New-CmdStub -Path (Join-Path $binDir "git.cmd") -Content "@echo off`necho git is unavailable in this profile 1>&2`nexit /b 9009`n"
}
if ([bool]$fixture.simulate.hideBash) {
    New-CmdStub -Path (Join-Path $binDir "bash.cmd") -Content "@echo off`necho bash is unavailable in this profile 1>&2`nexit /b 9009`n"
}
if ([bool]$fixture.simulate.hideDocker) {
    New-CmdStub -Path (Join-Path $binDir "docker.cmd") -Content "@echo off`necho docker is unavailable in this profile 1>&2`nexit /b 9009`n"
}

$portBlockerPid = $null
if ([bool]$fixture.simulate.occupyPort18789) {
    $script = '$listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,18789);$listener.Start();while($true){Start-Sleep -Seconds 5}'
    $proc = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile","-Command",$script -PassThru -WindowStyle Hidden
    $portBlockerPid = $proc.Id
}

if ([bool]$fixture.simulate.brokenOpenclawConfig) {
    $ocDir = Join-Path $profileRoot ".openclaw"
    New-Item -ItemType Directory -Force -Path $ocDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $ocDir "openclaw.json"), "{ invalid json ", [System.Text.Encoding]::UTF8)
}

$installDir = switch ([string]$fixture.simulate.installDirMode) {
    "chinese" { Join-Path $profileRoot "安装目录\OpenClaw" }
    "withSpaces" { Join-Path $profileRoot "OpenClaw Install\OpenClaw" }
    default { Join-Path $localAppData "OpenClaw" }
}

$state = [PSCustomObject]@{
    profile = $fixture.id
    createdAt = (Get-Date).ToString("s")
    sessionRoot = $sessionRoot
    binDir = $binDir
    profileRoot = $profileRoot
    appData = $appData
    localAppData = $localAppData
    appDataNpm = $appDataNpm
    evidenceDir = $evidenceDir
    installDir = $installDir
    portBlockerPid = $portBlockerPid
    networkRestricted = [bool]$fixture.simulate.networkRestricted
    npmMode = $npmMode
    npmPrefix = $npmPrefix
    nodeMode = $nodeMode
}
$state | ConvertTo-Json -Depth 4 | Out-File -FilePath $statePath -Encoding utf8

if ($ApplyToCurrentSession) {
    $env:PATH = "$binDir;$env:PATH"
    $env:USERPROFILE = $profileRoot
    $env:APPDATA = $appData
    $env:LOCALAPPDATA = $localAppData
    $env:OPENCLAW_INSTALL_DIR = $installDir
    $env:OPENCLAW_TEST_MODE = "1"
}

Write-Host "Profile prepared: $($fixture.id)" -ForegroundColor Green
Write-Host "State file: $statePath"
Write-Host "Use run script:"
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\Run-PortableInstallerTest.ps1`" -ExePath <path-to-exe> -StateFile `"$statePath`""


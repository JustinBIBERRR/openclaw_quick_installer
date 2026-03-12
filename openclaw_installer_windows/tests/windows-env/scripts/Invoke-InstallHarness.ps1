param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("NodeAlreadyInstalled", "WingetBootstrap", "NoWinget", "NodeOldVersion16", "NpmPermissionDenied", "NetworkRestricted", "PathRefreshFailed")]
    [string]$Profile
)

$ErrorActionPreference = "Stop"

function New-CmdStub {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.Encoding]::ASCII)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$installScript = Join-Path $repoRoot "src-tauri\scripts\install.ps1"
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-install-harness-" + [guid]::NewGuid().ToString("N"))
$binDir = Join-Path $workRoot "bin"
$profileDir = Join-Path $workRoot "profile"
$appDataDir = Join-Path $profileDir "AppData\Roaming"
$localAppDataDir = Join-Path $profileDir "AppData\Local"
$appDataNpmDir = Join-Path $appDataDir "npm"
$resultFile = Join-Path $workRoot "result.txt"
$installDir = Join-Path $workRoot "install-target"
$stdoutFile = Join-Path $workRoot "stdout.log"
$stderrFile = Join-Path $workRoot "stderr.log"

New-Item -ItemType Directory -Force -Path $binDir, $profileDir, $appDataDir, $localAppDataDir, $appDataNpmDir, $installDir | Out-Null

# node.cmd: 默认不可用，winget 成功后通过 flag 切换为可用
$nodeCmd = @'
@echo off
if exist "%~dp0node_ready.flag" (
  echo v22.11.0
  exit /b 0
)
if "%TEST_NODE_OLD%"=="1" (
  echo v16.20.0
  exit /b 0
)
echo node is not recognized as an internal or external command 1>&2
exit /b 1
'@
New-CmdStub -Path (Join-Path $binDir "node.cmd") -Content $nodeCmd

$wingetCmd = @'
@echo off
if "%TEST_WINGET_FAIL%"=="1" (
  echo winget unavailable 1>&2
  exit /b 5
)
echo winget install success
type nul > "%~dp0node_ready.flag"
exit /b 0
'@
New-CmdStub -Path (Join-Path $binDir "winget.cmd") -Content $wingetCmd

$customNpmPrefix = Join-Path $profileDir "CustomNpmPrefix"

$npmCmd = @'
@echo off
setlocal EnableDelayedExpansion
set args=%*
echo %args% | findstr /I "config get prefix" >nul
if %errorlevel%==0 (
  if "%TEST_PREFIX_MISMATCH%"=="1" (
    echo %TEST_NPM_PREFIX%
    exit /b 0
  )
  echo %APPDATA%\npm
  exit /b 0
)
echo %args% | findstr /I "install -g openclaw@latest" >nul
if %errorlevel%==0 (
  if "%TEST_NPM_FAIL%"=="permission" (
    echo npm ERR! code EPERM 1>&2
    exit /b 2
  )
  if "%TEST_NPM_FAIL%"=="network" (
    echo npm ERR! network request failed 1>&2
    exit /b 3
  )
  set target=%APPDATA%\npm
  if "%TEST_PREFIX_MISMATCH%"=="1" set target=%TEST_NPM_PREFIX%
  if not exist "!target!" mkdir "!target!"
  > "!target!\openclaw.cmd" echo @echo off
  >> "!target!\openclaw.cmd" echo if "%%1"=="--version" echo openclaw 9.9.9
  >> "!target!\openclaw.cmd" echo exit /b 0
  echo added 1 package
  exit /b 0
)
echo npm stub executed
exit /b 0
'@
New-CmdStub -Path (Join-Path $binDir "npm.cmd") -Content $npmCmd

switch ($Profile) {
    "NodeAlreadyInstalled" {
        New-Item -ItemType File -Path (Join-Path $binDir "node_ready.flag") -Force | Out-Null
    }
    "WingetBootstrap" {
        # 默认无 node_ready.flag，依赖 winget 安装成功后创建
    }
    "NoWinget" {
        $env:TEST_WINGET_FAIL = "1"
    }
    "NodeOldVersion16" {
        $env:TEST_NODE_OLD = "1"
    }
    "NpmPermissionDenied" {
        New-Item -ItemType File -Path (Join-Path $binDir "node_ready.flag") -Force | Out-Null
        $env:TEST_NPM_FAIL = "permission"
    }
    "NetworkRestricted" {
        New-Item -ItemType File -Path (Join-Path $binDir "node_ready.flag") -Force | Out-Null
        $env:TEST_NPM_FAIL = "network"
    }
    "PathRefreshFailed" {
        New-Item -ItemType File -Path (Join-Path $binDir "node_ready.flag") -Force | Out-Null
        New-Item -ItemType Directory -Force -Path $customNpmPrefix | Out-Null
        $env:TEST_PREFIX_MISMATCH = "1"
        $env:TEST_NPM_PREFIX = $customNpmPrefix
    }
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "powershell"
$psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$installScript`""
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.WorkingDirectory = $repoRoot
$systemPathParts = @(
    (Join-Path $env:WINDIR "System32"),
    (Join-Path $env:WINDIR "System32\Wbem"),
    (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0"),
    $env:WINDIR
) | Where-Object { $_ -and (Test-Path $_) }
$isolatedPath = @($binDir) + $systemPathParts | Select-Object -Unique
$psi.Environment["PATH"] = ($isolatedPath -join ";")
$psi.Environment["USERPROFILE"] = $profileDir
$psi.Environment["APPDATA"] = $appDataDir
$psi.Environment["LOCALAPPDATA"] = $localAppDataDir
$psi.Environment["OPENCLAW_INSTALL_DIR"] = $installDir
$psi.Environment["OPENCLAW_RESULT_FILE"] = $resultFile
$psi.Environment["OPENCLAW_TEST_MODE"] = "1"
$psi.Environment["TEST_WINGET_FAIL"] = $env:TEST_WINGET_FAIL
$psi.Environment["TEST_NPM_FAIL"] = $env:TEST_NPM_FAIL
$psi.Environment["TEST_NODE_OLD"] = $env:TEST_NODE_OLD
$psi.Environment["TEST_PREFIX_MISMATCH"] = $env:TEST_PREFIX_MISMATCH
$psi.Environment["TEST_NPM_PREFIX"] = $env:TEST_NPM_PREFIX

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $psi
[void]$process.Start()
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
$process.WaitForExit()

[System.IO.File]::WriteAllText($stdoutFile, $stdout, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($stderrFile, $stderr, [System.Text.Encoding]::UTF8)

$resultText = ""
if (Test-Path $resultFile) {
    $resultText = (Get-Content -Raw -Path $resultFile).Trim()
}

$installInfoPath = Join-Path $installDir "install-info.json"
$logDir = Join-Path $installDir "logs"
$logFiles = @()
if (Test-Path $logDir) {
    $logFiles = Get-ChildItem -Path $logDir -File | Select-Object -ExpandProperty FullName
}

[PSCustomObject]@{
    Profile = $Profile
    ExitCode = $process.ExitCode
    ResultText = $resultText
    InstallInfoExists = (Test-Path $installInfoPath)
    OpenclawCmdExists = (Test-Path (Join-Path $appDataNpmDir "openclaw.cmd"))
    CustomPrefixOpenclawExists = (Test-Path (Join-Path $customNpmPrefix "openclaw.cmd"))
    LogFileCount = $logFiles.Count
    StdoutFile = $stdoutFile
    StderrFile = $stderrFile
    WorkRoot = $workRoot
}

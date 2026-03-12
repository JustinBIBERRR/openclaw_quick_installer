param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath,
    [string]$ProfileName,
    [string]$StateFile,
    [int]$TimeoutSec = 180,
    [switch]$CaptureScreenshot,
    [string]$AutomationPlan,
    [string]$WindowTitle = "OpenClaw 一键安装器"
)

$ErrorActionPreference = "Stop"

function Get-FixturePath {
    param([string]$profileName)
    Join-Path (Join-Path $PSScriptRoot "..\fixtures") "$profileName.json"
}

function Get-AutomationPlanPath {
    param([string]$profileName)
    Join-Path (Join-Path $PSScriptRoot "..\automation\plans") "$profileName.json"
}

function Get-FileSnapshot {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        return $null
    }
    $item = Get-Item $Path
    [PSCustomObject]@{
        path = $item.FullName
        length = $item.Length
        lastWriteTime = $item.LastWriteTime.ToString("s")
        content = Get-Content -Raw -Path $item.FullName -Encoding UTF8
    }
}

function Get-TcpPortSnapshot {
    param([int]$Port)
    try {
        $entries = Get-NetTCPConnection -LocalPort $Port -ErrorAction Stop |
            Select-Object LocalAddress, LocalPort, State, OwningProcess
        [PSCustomObject]@{
            port = $Port
            listening = ($entries | Measure-Object).Count -gt 0
            entries = @($entries)
        }
    } catch {
        [PSCustomObject]@{
            port = $Port
            listening = $false
            entries = @()
        }
    }
}

function Get-ProcessSnapshot {
    param([int]$ProcessId)
    try {
        $proc = Get-Process -Id $ProcessId -ErrorAction Stop
        [PSCustomObject]@{
            id = $proc.Id
            name = $proc.ProcessName
            responding = $proc.Responding
            hasExited = $proc.HasExited
            startTime = $proc.StartTime.ToString("s")
        }
    } catch {
        $null
    }
}

function Save-Screenshot {
    param([string]$Path)
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
        return $true
    } catch {
        return $false
    }
}

if (-not (Test-Path $ExePath)) {
    throw "找不到 exe: $ExePath"
}

if (-not $StateFile) {
    if (-not $ProfileName) {
        throw "必须提供 -StateFile 或 -Profile"
    }
    $prepareScript = Join-Path $PSScriptRoot "Prepare-TestProfile.ps1"
    & $prepareScript -Profile $ProfileName | Out-Null
    $runtimeRoot = Resolve-Path (Join-Path $PSScriptRoot "..\runtime")
    $stateFile = Get-ChildItem -Path $runtimeRoot -Filter "profile-state.json" -Recurse |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}

if (-not (Test-Path $StateFile)) {
    throw "找不到 state file: $StateFile"
}

$state = Get-Content -Raw -Path $StateFile -Encoding UTF8 | ConvertFrom-Json
$fixturePath = Get-FixturePath $state.profile
$fixture = if (Test-Path $fixturePath) {
    Get-Content -Raw -Path $fixturePath -Encoding UTF8 | ConvertFrom-Json
} else {
    $null
}
$evidenceFile = Join-Path $state.evidenceDir ("run-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
$stdoutFile = Join-Path $state.evidenceDir ("installer-stdout-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$stderrFile = Join-Path $state.evidenceDir ("installer-stderr-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$beforeScreenshot = Join-Path $state.evidenceDir ("screenshot-before-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".png")
$afterScreenshot = Join-Path $state.evidenceDir ("screenshot-after-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".png")

if ($CaptureScreenshot) {
    [void](Save-Screenshot -Path $beforeScreenshot)
}

if (-not $AutomationPlan) {
    $candidatePlan = Get-AutomationPlanPath $state.profile
    if (Test-Path $candidatePlan) {
        $AutomationPlan = $candidatePlan
    }
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = (Resolve-Path $ExePath).Path
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.WorkingDirectory = Split-Path -Parent $ExePath
$psi.Environment["PATH"] = "$($state.binDir);$env:PATH"
$psi.Environment["USERPROFILE"] = $state.profileRoot
$psi.Environment["APPDATA"] = $state.appData
$psi.Environment["LOCALAPPDATA"] = $state.localAppData
$psi.Environment["OPENCLAW_INSTALL_DIR"] = $state.installDir
$psi.Environment["OPENCLAW_TEST_MODE"] = "1"

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()

Start-Sleep -Seconds 2
if ($CaptureScreenshot) {
    [void](Save-Screenshot -Path $afterScreenshot)
}

$automationLogFile = $null
if ($AutomationPlan -and (Test-Path $AutomationPlan)) {
    try {
        $automationScript = Join-Path $PSScriptRoot "Invoke-GuiAutomation.ps1"
        $automationLogFile = & $automationScript -PlanFile $AutomationPlan -WindowTitle $WindowTitle -EvidenceDir $state.evidenceDir
    } catch {
        $automationLogFile = $null
    }
}

$finished = $proc.WaitForExit($TimeoutSec * 1000)
if (-not $finished) {
    try { $proc.Kill() } catch {}
}

$stdout = $proc.StandardOutput.ReadToEnd()
$stderr = $proc.StandardError.ReadToEnd()
[System.IO.File]::WriteAllText($stdoutFile, $stdout, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($stderrFile, $stderr, [System.Text.Encoding]::UTF8)

$installInfo = Join-Path $state.installDir "install-info.json"
$installLogDir = Join-Path $state.installDir "logs"
$installLogs = @()
if (Test-Path $installLogDir) {
    $installLogs = Get-ChildItem -Path $installLogDir -File | Select-Object -ExpandProperty FullName
}

$openclawConfigPath = Join-Path $state.profileRoot ".openclaw\openclaw.json"
$manifestPath = Join-Path $state.installDir "manifest.json"
$logTail = @()
if ($installLogs.Count -gt 0) {
    $latestLog = $installLogs | Select-Object -Last 1
    $logTail = @(Get-Content -Path $latestLog -Tail 20 -Encoding UTF8)
}
$portSnapshot = Get-TcpPortSnapshot -Port 18789
$processSnapshot = Get-ProcessSnapshot -Pid $proc.Id

$successSignals = @()
if (Test-Path $installInfo) { $successSignals += "install-info" }
if (Test-Path $openclawConfigPath) { $successSignals += "openclaw-config" }
if (Test-Path $manifestPath) { $successSignals += "manifest" }
if ($portSnapshot.listening) { $successSignals += "gateway-port" }

$failureSignals = @()
if (-not $finished) { $failureSignals += "timeout" }
if (-not [string]::IsNullOrWhiteSpace($stderr)) { $failureSignals += "stderr" }
if ($logTail | Where-Object { $_ -match "\[ERROR\]|失败|error:" }) { $failureSignals += "log-error" }

$result = [PSCustomObject]@{
    profile = $state.profile
    profileDescription = $fixture.description
    expectedInstallShouldPass = if ($fixture) { [bool]$fixture.expected.installShouldPass } else { $null }
    riskLevel = if ($fixture) { [string]$fixture.expected.riskLevel } else { $null }
    exePath = (Resolve-Path $ExePath).Path
    finished = $finished
    timeoutSec = $TimeoutSec
    exitCode = if ($finished) { $proc.ExitCode } else { $null }
    processSnapshot = $processSnapshot
    portSnapshot = $portSnapshot
    installInfoExists = (Test-Path $installInfo)
    installInfoPath = $installInfo
    installInfo = Get-FileSnapshot -Path $installInfo
    manifestExists = (Test-Path $manifestPath)
    manifestPath = $manifestPath
    manifest = Get-FileSnapshot -Path $manifestPath
    installLogCount = $installLogs.Count
    installLogs = $installLogs
    installLogTail = $logTail
    openclawConfigExists = (Test-Path $openclawConfigPath)
    openclawConfigPath = $openclawConfigPath
    openclawConfig = Get-FileSnapshot -Path $openclawConfigPath
    stdoutFile = $stdoutFile
    stderrFile = $stderrFile
    stdoutLength = $stdout.Length
    stderrLength = $stderr.Length
    screenshotBefore = if (Test-Path $beforeScreenshot) { $beforeScreenshot } else { $null }
    screenshotAfter = if (Test-Path $afterScreenshot) { $afterScreenshot } else { $null }
    automationPlan = $AutomationPlan
    automationLogFile = $automationLogFile
    successSignals = @($successSignals)
    failureSignals = @($failureSignals)
    stateFile = $StateFile
    capturedAt = (Get-Date).ToString("s")
}

$result | ConvertTo-Json -Depth 6 | Out-File -FilePath $evidenceFile -Encoding utf8
Write-Host "Evidence generated: $evidenceFile" -ForegroundColor Green
Write-Output $result

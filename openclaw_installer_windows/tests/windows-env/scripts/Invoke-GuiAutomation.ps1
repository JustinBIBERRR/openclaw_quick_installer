param(
    [Parameter(Mandatory = $true)]
    [string]$PlanFile,
    [string]$WindowTitle = "OpenClaw 一键安装器",
    [string]$EvidenceDir
)

$ErrorActionPreference = "Stop"

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

function Wait-WindowActive {
    param(
        [string]$Title,
        [int]$TimeoutSec = 20
    )
    $shell = New-Object -ComObject WScript.Shell
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($shell.AppActivate($Title)) {
            Start-Sleep -Milliseconds 400
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

if (-not (Test-Path $PlanFile)) {
    throw "Automation plan not found: $PlanFile"
}

if (-not $EvidenceDir) {
    $EvidenceDir = Split-Path -Parent $PlanFile
}
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

$plan = Get-Content -Raw -Path $PlanFile -Encoding UTF8 | ConvertFrom-Json
$shell = New-Object -ComObject WScript.Shell
$actionLog = @()

foreach ($action in $plan.actions) {
    $type = [string]$action.type
    $entry = [ordered]@{
        at = (Get-Date).ToString("s")
        type = $type
        ok = $true
    }

    switch ($type) {
        "wait_window" {
            $timeoutSec = if ($action.timeoutSec) { [int]$action.timeoutSec } else { 20 }
            $ok = Wait-WindowActive -Title $WindowTitle -TimeoutSec $timeoutSec
            $entry.ok = $ok
            $entry.timeoutSec = $timeoutSec
        }
        "sleep" {
            $ms = if ($action.ms) { [int]$action.ms } else { 1000 }
            Start-Sleep -Milliseconds $ms
            $entry.ms = $ms
        }
        "activate" {
            $ok = $shell.AppActivate($WindowTitle)
            Start-Sleep -Milliseconds 400
            $entry.ok = $ok
        }
        "keys" {
            $keys = [string]$action.keys
            $shell.SendKeys($keys)
            Start-Sleep -Milliseconds 500
            $entry.keys = $keys
        }
        "screenshot" {
            $name = if ($action.name) { [string]$action.name } else { "gui-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".png" }
            $path = Join-Path $EvidenceDir $name
            $entry.ok = Save-Screenshot -Path $path
            $entry.path = $path
        }
        default {
            $entry.ok = $false
            $entry.error = "Unknown action type: $type"
        }
    }

    $actionLog += [PSCustomObject]$entry
}

$resultFile = Join-Path $EvidenceDir ("gui-automation-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
[PSCustomObject]@{
    planFile = (Resolve-Path $PlanFile).Path
    windowTitle = $WindowTitle
    actions = $actionLog
    capturedAt = (Get-Date).ToString("s")
} | ConvertTo-Json -Depth 6 | Out-File -FilePath $resultFile -Encoding utf8

Write-Output $resultFile

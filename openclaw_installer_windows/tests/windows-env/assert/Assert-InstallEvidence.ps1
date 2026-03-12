param(
    [Parameter(Mandatory = $true)]
    [string]$EvidenceFile
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $EvidenceFile)) {
    throw "Evidence file not found: $EvidenceFile"
}

$ev = Get-Content -Raw -Path $EvidenceFile -Encoding UTF8 | ConvertFrom-Json
$errors = @()
$expectedPass = $ev.expectedInstallShouldPass
$successSignalCount = @($ev.successSignals).Count
$failureSignalCount = @($ev.failureSignals).Count

if (-not $ev.finished) {
    $errors += "installer timed out or exited unexpectedly"
}
if (-not $ev.installLogCount -or [int]$ev.installLogCount -lt 1) {
    $errors += "no install logs were captured"
}
if (-not (Test-Path $ev.stdoutFile)) {
    $errors += "stdout file is missing"
}
if (-not (Test-Path $ev.stderrFile)) {
    $errors += "stderr file is missing"
}
if ($ev.screenshotBefore -and -not (Test-Path $ev.screenshotBefore)) {
    $errors += "before screenshot is missing"
}
if ($ev.screenshotAfter -and -not (Test-Path $ev.screenshotAfter)) {
    $errors += "after screenshot is missing"
}

if ($null -ne $expectedPass) {
    if ($expectedPass) {
        if ($successSignalCount -lt 1) {
            $errors += "expected success but no success signal was captured"
        }
    } else {
        if ($failureSignalCount -lt 1 -and $successSignalCount -gt 0) {
            $errors += "expected failure but no explicit failure signal was captured"
        }
    }
}

if ($errors.Count -gt 0) {
    Write-Host "Evidence assertion failed" -ForegroundColor Red
    $errors | ForEach-Object { Write-Host "- $_" -ForegroundColor Red }
    exit 1
}

Write-Host "Evidence assertion passed: $EvidenceFile" -ForegroundColor Green

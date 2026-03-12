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
    $errors += "安装器运行超时或异常退出"
}
if (-not $ev.installLogCount -or [int]$ev.installLogCount -lt 1) {
    $errors += "未采集到安装日志"
}
if (-not (Test-Path $ev.stdoutFile)) {
    $errors += "stdout 文件不存在"
}
if (-not (Test-Path $ev.stderrFile)) {
    $errors += "stderr 文件不存在"
}
if ($ev.screenshotBefore -and -not (Test-Path $ev.screenshotBefore)) {
    $errors += "启动前截图文件不存在"
}
if ($ev.screenshotAfter -and -not (Test-Path $ev.screenshotAfter)) {
    $errors += "启动后截图文件不存在"
}

if ($null -ne $expectedPass) {
    if ($expectedPass) {
        if ($successSignalCount -lt 1) {
            $errors += "预期应成功，但没有采集到成功信号"
        }
    } else {
        if ($failureSignalCount -lt 1 -and $successSignalCount -gt 0) {
            $errors += "预期应失败，但 evidence 未体现明确失败信号"
        }
    }
}

if ($errors.Count -gt 0) {
    Write-Host "Evidence assertion failed" -ForegroundColor Red
    $errors | ForEach-Object { Write-Host "- $_" -ForegroundColor Red }
    exit 1
}

Write-Host "Evidence assertion passed: $EvidenceFile" -ForegroundColor Green

$ErrorActionPreference = "Stop"

$assertScript = Join-Path $PSScriptRoot "..\assert\Assert-InstallEvidence.ps1"

function Invoke-AssertScript {
    param([string]$EvidenceFile)
    $proc = Start-Process -FilePath "powershell" `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $assertScript, "-EvidenceFile", $EvidenceFile `
        -PassThru -Wait -NoNewWindow
    $proc.ExitCode
}

Describe "evidence assertions" {
    It "passes when success profile has success signals and required files" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("evidence-pass-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        $stdout = Join-Path $tmp "stdout.log"
        $stderr = Join-Path $tmp "stderr.log"
        $shot1 = Join-Path $tmp "before.png"
        $shot2 = Join-Path $tmp "after.png"
        $log1 = Join-Path $tmp "install.log"
        Set-Content -Path $stdout -Value "ok" -Encoding UTF8
        Set-Content -Path $stderr -Value "" -Encoding UTF8
        Set-Content -Path $shot1 -Value "img" -Encoding UTF8
        Set-Content -Path $shot2 -Value "img" -Encoding UTF8
        Set-Content -Path $log1 -Value "install ok" -Encoding UTF8
        $evidence = @{
            expectedInstallShouldPass = $true
            finished = $true
            installLogCount = 1
            stdoutFile = $stdout
            stderrFile = $stderr
            screenshotBefore = $shot1
            screenshotAfter = $shot2
            successSignals = @("install-info")
            failureSignals = @()
        }
        $evFile = Join-Path $tmp "evidence.json"
        $evidence | ConvertTo-Json -Depth 5 | Out-File -FilePath $evFile -Encoding utf8

        (Invoke-AssertScript -EvidenceFile $evFile) | Should -Be 0
    }

    It "passes when failure profile has explicit failure signals" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("evidence-fail-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        $stdout = Join-Path $tmp "stdout.log"
        $stderr = Join-Path $tmp "stderr.log"
        $log1 = Join-Path $tmp "install.log"
        Set-Content -Path $stdout -Value "" -Encoding UTF8
        Set-Content -Path $stderr -Value "error" -Encoding UTF8
        Set-Content -Path $log1 -Value "[ERROR] failed" -Encoding UTF8
        $evidence = @{
            expectedInstallShouldPass = $false
            finished = $true
            installLogCount = 1
            stdoutFile = $stdout
            stderrFile = $stderr
            screenshotBefore = $null
            screenshotAfter = $null
            successSignals = @()
            failureSignals = @("stderr", "log-error")
        }
        $evFile = Join-Path $tmp "evidence.json"
        $evidence | ConvertTo-Json -Depth 5 | Out-File -FilePath $evFile -Encoding utf8

        (Invoke-AssertScript -EvidenceFile $evFile) | Should -Be 0
    }
}

param(
    [string]$Path = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

if (-not (Get-Module -ListAvailable -Name Pester)) {
    Write-Host "Pester is missing, installing for CurrentUser..." -ForegroundColor Yellow
    Install-Module Pester -Scope CurrentUser -Force -SkipPublisherCheck
}

Import-Module Pester -Force

if (Get-Command New-PesterConfiguration -ErrorAction SilentlyContinue) {
    $config = New-PesterConfiguration
    $config.Run.Path = $Path
    $config.Output.Verbosity = "Detailed"
    $config.Should.ErrorAction = "Stop"
    $result = Invoke-Pester -Configuration $config
    if ($result.FailedCount -gt 0) {
        exit 1
    }
} else {
    # 兼容 Windows PowerShell 上的旧版 Pester（v4）
    $result = Invoke-Pester -Script $Path -PassThru
    if ($result.FailedCount -gt 0) {
        exit 1
    }
}

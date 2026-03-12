param(
    [string]$Path = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

$minPesterVersion = [Version]"5.4.0"
$installedPester = Get-Module -ListAvailable -Name Pester |
    Sort-Object Version -Descending |
    Select-Object -First 1

if (-not $installedPester -or $installedPester.Version -lt $minPesterVersion) {
    throw "Pester >= $minPesterVersion is required. Installed: $($installedPester.Version)"
}

Import-Module Pester -MinimumVersion $minPesterVersion -Force

if (Get-Command New-PesterConfiguration -ErrorAction SilentlyContinue) {
    $config = New-PesterConfiguration
    $config.Run.Path = $Path
    $config.Output.Verbosity = "Detailed"
    $config.Should.ErrorAction = "Stop"
    $result = Invoke-Pester -Configuration $config
    if (
        $result.FailedCount -gt 0 -or
        $result.FailedBlocksCount -gt 0 -or
        $result.FailedContainersCount -gt 0
    ) {
        exit 1
    }
} else {
    throw "Pester v5 is required, but New-PesterConfiguration is unavailable."
}

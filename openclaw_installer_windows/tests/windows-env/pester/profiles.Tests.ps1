$ErrorActionPreference = "Stop"

$prepare = Join-Path $PSScriptRoot "..\scripts\Prepare-TestProfile.ps1"
$reset = Join-Path $PSScriptRoot "..\scripts\Reset-TestProfile.ps1"
$runtimeRoot = Join-Path $PSScriptRoot "..\runtime-pester"

function Get-LatestState {
    $stateFile = Get-ChildItem -Path $runtimeRoot -Filter "profile-state.json" -Recurse |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    Get-Content -Raw -Path $stateFile -Encoding UTF8 | ConvertFrom-Json
}

Describe "windows-env profiles" {
    AfterEach {
        & $reset -RuntimeRoot $runtimeRoot -Deep
    }

    It "prepares every documented fixture successfully" {
        @(
            "CleanNoNode",
            "NoWinget",
            "NodeOldVersion16",
            "NpmGlobalInstallDenied",
            "PathRefreshFailed",
            "ChineseUserProfile",
            "ChineseInstallDir",
            "PathWithSpaces",
            "PortOccupied18789",
            "BrokenOpenclawConfig",
            "NetworkRestricted",
            "WinHomeNoHyperV"
        ) | ForEach-Object {
            & $prepare -Profile $_ -RuntimeRoot $runtimeRoot | Out-Null
            $state = Get-LatestState

            $state.profile | Should -Be $_
            (Test-Path (Join-Path $state.binDir "node.cmd")) | Should -BeTrue
            (Test-Path (Join-Path $state.binDir "npm.cmd")) | Should -BeTrue
            (Test-Path (Join-Path $state.binDir "winget.cmd")) | Should -BeTrue

            & $reset -RuntimeRoot $runtimeRoot -Deep
        }
    }

    It "creates a Chinese profile root for ChineseUserProfile" {
        & $prepare -Profile ChineseUserProfile -RuntimeRoot $runtimeRoot | Out-Null
        $state = Get-LatestState

        $state.profileRoot | Should -Match "测试用户"
        (Test-Path (Join-Path $state.binDir "node.cmd")) | Should -BeTrue
        (Test-Path (Join-Path $state.binDir "npm.cmd")) | Should -BeTrue
        (Test-Path (Join-Path $state.binDir "winget.cmd")) | Should -BeTrue
    }

    It "marks PathRefreshFailed with prefix mismatch state" {
        & $prepare -Profile PathRefreshFailed -RuntimeRoot $runtimeRoot | Out-Null
        $state = Get-LatestState

        $state.npmMode | Should -Be "prefix_mismatch"
        $state.npmPrefix | Should -Match "CustomNpmPrefix"
    }

    It "marks NpmGlobalInstallDenied with permission denied mode" {
        & $prepare -Profile NpmGlobalInstallDenied -RuntimeRoot $runtimeRoot | Out-Null
        $state = Get-LatestState

        $state.npmMode | Should -Be "permission_denied"
    }

    It "creates broken config when profile requests it" {
        & $prepare -Profile BrokenOpenclawConfig -RuntimeRoot $runtimeRoot | Out-Null
        $state = Get-LatestState
        $configPath = Join-Path $state.profileRoot ".openclaw\openclaw.json"

        (Test-Path $configPath) | Should -BeTrue
    }

    It "creates port blocker when requested" {
        & $prepare -Profile PortOccupied18789 -RuntimeRoot $runtimeRoot | Out-Null
        $state = Get-LatestState

        $state.portBlockerPid | Should -Not -BeNullOrEmpty
    }
}

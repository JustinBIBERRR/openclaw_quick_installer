$ErrorActionPreference = "Stop"

function Get-LatestState {
    param([string]$RuntimeRoot)
    $stateFile = Get-ChildItem -Path $RuntimeRoot -Filter "profile-state.json" -Recurse |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    Get-Content -Raw -Path $stateFile -Encoding UTF8 | ConvertFrom-Json
}

Describe "windows-env profiles" {
    BeforeAll {
        $script:prepare = (Resolve-Path (Join-Path $PSScriptRoot "..\scripts\Prepare-TestProfile.ps1")).Path
        $script:reset = (Resolve-Path (Join-Path $PSScriptRoot "..\scripts\Reset-TestProfile.ps1")).Path
        $runtimeRootPath = Join-Path $PSScriptRoot "..\runtime-pester"
        if (-not (Test-Path $runtimeRootPath)) {
            New-Item -ItemType Directory -Force -Path $runtimeRootPath | Out-Null
        }
        $script:runtimeRoot = (Resolve-Path $runtimeRootPath).Path
    }
    AfterEach {
        & $script:reset -RuntimeRoot $script:runtimeRoot -Deep
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
            & $script:prepare -Profile $_ -RuntimeRoot $script:runtimeRoot | Out-Null
            $state = Get-LatestState -RuntimeRoot $script:runtimeRoot

            $state.profile | Should -Be $_
            (Test-Path (Join-Path $state.binDir "node.cmd")) | Should -BeTrue
            (Test-Path (Join-Path $state.binDir "npm.cmd")) | Should -BeTrue
            (Test-Path (Join-Path $state.binDir "winget.cmd")) | Should -BeTrue

            & $script:reset -RuntimeRoot $script:runtimeRoot -Deep
        }
    }

    It "creates a Chinese profile root for ChineseUserProfile" {
        & $script:prepare -Profile ChineseUserProfile -RuntimeRoot $script:runtimeRoot | Out-Null
        $state = Get-LatestState -RuntimeRoot $script:runtimeRoot

        $state.profileRoot | Should -Match "测试用户"
        (Test-Path (Join-Path $state.binDir "node.cmd")) | Should -BeTrue
        (Test-Path (Join-Path $state.binDir "npm.cmd")) | Should -BeTrue
        (Test-Path (Join-Path $state.binDir "winget.cmd")) | Should -BeTrue
    }

    It "marks PathRefreshFailed with prefix mismatch state" {
        & $script:prepare -Profile PathRefreshFailed -RuntimeRoot $script:runtimeRoot | Out-Null
        $state = Get-LatestState -RuntimeRoot $script:runtimeRoot

        $state.npmMode | Should -Be "prefix_mismatch"
        $state.npmPrefix | Should -Match "CustomNpmPrefix"
    }

    It "marks NpmGlobalInstallDenied with permission denied mode" {
        & $script:prepare -Profile NpmGlobalInstallDenied -RuntimeRoot $script:runtimeRoot | Out-Null
        $state = Get-LatestState -RuntimeRoot $script:runtimeRoot

        $state.npmMode | Should -Be "permission_denied"
    }

    It "creates broken config when profile requests it" {
        & $script:prepare -Profile BrokenOpenclawConfig -RuntimeRoot $script:runtimeRoot | Out-Null
        $state = Get-LatestState -RuntimeRoot $script:runtimeRoot
        $configPath = Join-Path $state.profileRoot ".openclaw\openclaw.json"

        (Test-Path $configPath) | Should -BeTrue
    }

    It "creates port blocker when requested" {
        & $script:prepare -Profile PortOccupied18789 -RuntimeRoot $script:runtimeRoot | Out-Null
        $state = Get-LatestState -RuntimeRoot $script:runtimeRoot

        $state.portBlockerPid | Should -Not -BeNullOrEmpty
    }
}

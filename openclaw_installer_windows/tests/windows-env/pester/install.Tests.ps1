$ErrorActionPreference = "Stop"

$harness = Join-Path $PSScriptRoot "..\scripts\Invoke-InstallHarness.ps1"

Describe "install.ps1 harness" {
    It "passes when Node is already installed" {
        $result = & $harness -Profile NodeAlreadyInstalled
        $result.ExitCode | Should -Be 0
        $result.ResultText | Should -Be "install_ok"
        $result.InstallInfoExists | Should -BeTrue
        $result.OpenclawCmdExists | Should -BeTrue
        $result.LogFileCount | Should -BeGreaterThan 0
    }

    It "passes when winget bootstrap is required" {
        $result = & $harness -Profile WingetBootstrap
        $result.ExitCode | Should -Be 0
        $result.ResultText | Should -Be "install_ok"
        $result.InstallInfoExists | Should -BeTrue
        $result.OpenclawCmdExists | Should -BeTrue
    }

    It "fails with deterministic error when winget is unavailable" {
        $result = & $harness -Profile NoWinget
        $result.ExitCode | Should -Not -Be 0
        $result.ResultText | Should -Match "^error:"
    }

    It "upgrades from old Node 16 via winget path" {
        $result = & $harness -Profile NodeOldVersion16
        $result.ExitCode | Should -Be 0
        $result.ResultText | Should -Be "install_ok"
        $result.InstallInfoExists | Should -BeTrue
    }

    It "fails deterministically on npm permission denied" {
        $result = & $harness -Profile NpmPermissionDenied
        $result.ExitCode | Should -Not -Be 0
        $result.ResultText | Should -Match "^error:"
        $result.OpenclawCmdExists | Should -BeFalse
    }

    It "fails deterministically on npm network restriction" {
        $result = & $harness -Profile NetworkRestricted
        $result.ExitCode | Should -Not -Be 0
        $result.ResultText | Should -Match "^error:"
    }

    It "fails verification when npm prefix mismatches PATH discovery" {
        $result = & $harness -Profile PathRefreshFailed
        $result.ExitCode | Should -Not -Be 0
        $result.ResultText | Should -Match "^error:"
        $result.CustomPrefixOpenclawExists | Should -BeTrue
        $result.OpenclawCmdExists | Should -BeFalse
    }
}

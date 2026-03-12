param(
    [string]$RuntimeRoot
)

$ErrorActionPreference = "Stop"

if (-not $RuntimeRoot) {
    $RuntimeRoot = Join-Path $PSScriptRoot "..\runtime"
}

$runtime = Resolve-Path $RuntimeRoot -ErrorAction SilentlyContinue
if (-not $runtime) {
    throw "Runtime directory does not exist: $RuntimeRoot"
}

$latest = Get-ChildItem -Path $runtime -Filter "run-*.json" -Recurse |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $latest) {
    throw "No run-*.json evidence file found"
}

Write-Output $latest.FullName

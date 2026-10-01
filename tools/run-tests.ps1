# Run every dsh-serial-debugger test suite.
#
#   powershell -ExecutionPolicy Bypass -File tools\run-tests.ps1
#
# Locates a Node runtime (PATH, then the DSH primary runtime) and runs the four
# hardware-free suites. Exits non-zero if any suite fails.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$toolsDir = $PSScriptRoot

function Resolve-Node {
    $fromPath = Get-Command node -ErrorAction SilentlyContinue
    if ($fromPath) { return $fromPath.Source }
    $candidates = @(
        (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "no Node runtime found; install Node or pass one on PATH"
}

$node = Resolve-Node
Write-Host "node: $node"
Write-Host ""

$suites = @(
    @{ Name = 'serial bridge protocol'; File = 'test-helper.mjs' },
    @{ Name = 'host half + HTTP route'; File = 'test-host.mjs' },
    @{ Name = 'client bundle + render'; File = 'test-client.mjs' },
    @{ Name = 'full data path (loopback)'; File = 'test-loopback.mjs' }
)

$failed = @()
foreach ($suite in $suites) {
    Write-Host "--- $($suite.Name) ---"
    & $node (Join-Path $toolsDir $suite.File)
    if ($LASTEXITCODE -ne 0) { $failed += $suite.Name }
    Write-Host ""
}

if ($failed.Count -gt 0) {
    Write-Host "FAILED: $($failed -join ', ')"
    exit 1
}
Write-Host "all suites passed"

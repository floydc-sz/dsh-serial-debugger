# Run every dsh-serial-debugger test suite.
#
#   powershell -ExecutionPolicy Bypass -File tools\run-tests.ps1
#
# Thin shim: the runner lives in tools/run-tests.mjs so that one command works on
# Windows and Linux alike. This file only locates a Node runtime.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

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
& $node (Join-Path $PSScriptRoot 'run-tests.mjs')
exit $LASTEXITCODE

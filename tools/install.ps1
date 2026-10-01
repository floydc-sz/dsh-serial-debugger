# Install dsh-serial-debugger into a DSH profile.
#
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -ProfileDir "C:\path\to\profile"
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Uninstall
#
# Copies the package into the profile's node_modules and inserts one Loader row
# into the profile's user patch layer, after backing that layer up. Idempotent:
# re-running replaces the package copy and does not duplicate the patch entry.
#
# The patch file is rewritten as UTF-8 without a BOM (PowerShell's
# `Set-Content -Encoding UTF8` adds one on 5.1, which can break a YAML parser).

[CmdletBinding()]
param(
    [string]$ProfileDir,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$packageRoot = Split-Path -Parent $PSScriptRoot
$packageName = 'dsh-serial-debugger'

if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'package.json'))) {
    throw "package.json not found next to tools\; run this script from the package checkout."
}

if (-not $ProfileDir) {
    if ($env:DSH_PROFILE_DIR) {
        $ProfileDir = $env:DSH_PROFILE_DIR
    } else {
        $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
    }
}

$profilePath = (Resolve-Path -LiteralPath $ProfileDir).Path
$patchPath = Join-Path $profilePath 'cordis.patch.yml'
$modulesPath = Join-Path $profilePath 'node_modules'
$targetPath = Join-Path $modulesPath $packageName

if (-not (Test-Path -LiteralPath $patchPath)) { throw "not a DSH profile (no cordis.patch.yml): $profilePath" }
if (-not (Test-Path -LiteralPath $modulesPath)) { throw "not a DSH profile (no node_modules): $profilePath" }

# Guard: the copy target must sit directly inside this profile's node_modules.
if ((Split-Path -Parent $targetPath) -ne $modulesPath) {
    throw "refusing to operate on an unexpected path: $targetPath"
}

Write-Host "profile : $profilePath"
Write-Host "package : $targetPath"

$marker = "# $packageName - serial debugger panel (added by tools/install.ps1)"
$rowLine = "      name: $packageName"

function Read-PatchText {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $offset = if ($hasBom) { 3 } else { 0 }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes, $offset, $bytes.Length - $offset)
    return @{ Text = $text; Bom = $hasBom }
}

function Write-PatchText {
    param([string]$Path, [string]$Text, [bool]$Bom)
    $noBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $noBom)
}

# ── uninstall ───────────────────────────────────────────────────────────────

if ($Uninstall) {
    if (Test-Path -LiteralPath $targetPath) {
        Remove-Item -LiteralPath $targetPath -Recurse -Force
        Write-Host "removed the package copy"
    } else {
        Write-Host "no package copy to remove"
    }

    $patch = Read-PatchText -Path $patchPath
    $lines = $patch.Text -split "`n"
    $kept = New-Object System.Collections.Generic.List[string]
    $index = 0
    $removed = 0
    while ($index -lt $lines.Count) {
        # Remove exactly the block this installer appends: marker, insert, id, name.
        if ($lines[$index].Trim() -eq $marker.Trim()) {
            $end = $index
            for ($scan = $index; $scan -lt [Math]::Min($index + 5, $lines.Count); $scan++) {
                if ($lines[$scan].Trim() -eq $rowLine.Trim()) { $end = $scan; break }
            }
            $index = $end + 1
            $removed += 1
            continue
        }
        $kept.Add($lines[$index])
        $index += 1
    }

    if ($removed -gt 0) {
        $backup = "$patchPath.bak-$packageName"
        Copy-Item -LiteralPath $patchPath -Destination $backup -Force
        Write-PatchText -Path $patchPath -Text ($kept -join "`n") -Bom $patch.Bom
        Write-Host "removed $removed Loader row(s) from cordis.patch.yml (backup: $(Split-Path -Leaf $backup))"
    } else {
        Write-Host "cordis.patch.yml carries no Loader row for $packageName"
    }
    return
}

# ── install ─────────────────────────────────────────────────────────────────

if (Test-Path -LiteralPath $targetPath) {
    Remove-Item -LiteralPath $targetPath -Recurse -Force
}
New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
foreach ($item in @('lib', 'cordis.patch.yml', 'README.md', 'LICENSE', 'package.json')) {
    $source = Join-Path $packageRoot $item
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $targetPath -Recurse -Force
    }
}
Write-Host "copied package into node_modules"

$patch = Read-PatchText -Path $patchPath
if ($patch.Text -match [regex]::Escape("name: $packageName")) {
    Write-Host "cordis.patch.yml already carries the Loader row; left unchanged"
} else {
    $backup = "$patchPath.bak-$packageName"
    Copy-Item -LiteralPath $patchPath -Destination $backup -Force
    Write-Host "backed up cordis.patch.yml -> $(Split-Path -Leaf $backup)"

    $text = $patch.Text
    if (-not $text.EndsWith("`n")) { $text += "`n" }
    $text += @"
$marker
- insert:
    - id: serial-debugger
$rowLine
"@
    Write-PatchText -Path $patchPath -Text $text -Bom $patch.Bom
    Write-Host "inserted the Loader row into cordis.patch.yml"
}

$resolved = Join-Path $targetPath 'package.json'
if (Test-Path -LiteralPath $resolved) {
    $manifest = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json
    Write-Host "installed $($manifest.name)@$($manifest.version)"
}
Write-Host "done. Reload DSH (or let HMR apply) and look for the '串口调试' entry in the sidebar."

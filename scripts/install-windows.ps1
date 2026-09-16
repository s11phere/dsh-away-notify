# install-windows.ps1 - install dsh-away-notify into a dsh profile on Windows.
#
# Why this exists: `dsh plugin --profile <name> add <path>` silently produces a
# BROKEN plugin on Windows whenever the plugin checkout is on a different drive
# than $DSH_HOME (C: by default, and most checkouts live elsewhere). pnpm's
# `hoisted` nodeLinker, which the dsh profile template itself writes into
# pnpm-workspace.yaml, resolves the absolute `link:` spec as if it were RELATIVE,
# so the junction ends up pointing at:
#
#     C:\Users\<you>\.dsh\profiles\web\F:\project\...\dsh-away-notify
#     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ profile dir glued onto an absolute path
#
# The package then does not resolve, `dsh plugin` fails to register the bundle,
# and it reports the failure with a misleading warning ("declares no dsh.bundle")
# while still exiting 0. The plugin never loads, and nothing says so.
#
# This script runs the normal command and then VERIFIES the result, repairing the
# junction and the bundle list when pnpm got it wrong.
#
# THIS FILE MUST STAY PURE ASCII: Windows PowerShell 5.1 reads a .ps1 without a
# BOM using the ANSI code page, so any non-ASCII literal corrupts the parse.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#   ... -Profile web
#   ... -WhatIfOnly      (only report what would change)

param(
  [string]$Profile = 'web',
  [string]$PluginDir = (Split-Path -Parent $PSScriptRoot),
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host $m }
function Step($m) { Write-Host ""; Write-Host ("== " + $m) }

if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) {
  throw "not a plugin checkout (no package.json): $PluginDir"
}
$manifest = Get-Content (Join-Path $PluginDir 'package.json') -Raw | ConvertFrom-Json
$pkgName = $manifest.name
if (-not $pkgName) { throw "package.json has no name: $PluginDir" }
$PluginDir = (Resolve-Path $PluginDir).Path

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome ("profiles\" + $Profile)
$profileManifestPath = Join-Path $profileDir 'package.json'
$linkPath = Join-Path $profileDir ("node_modules\" + $pkgName)

Info ("plugin   : " + $PluginDir)
Info ("package  : " + $pkgName)
Info ("dsh home : " + $dshHome)
Info ("profile  : " + $Profile + "  (" + $profileDir + ")")
Info ("link     : " + $linkPath)

$pluginRoot = [System.IO.Path]::GetPathRoot($PluginDir)
$profileRoot = [System.IO.Path]::GetPathRoot($profileDir)
if ($pluginRoot -ne $profileRoot) {
  Info ""
  Info ("NOTE: plugin is on " + $pluginRoot + " but the profile is on " + $profileRoot + ".")
  Info "      That is exactly the case where pnpm's hoisted linker breaks the link."
}

Step "1/5 run the normal install (dsh plugin --profile $Profile add)"
if ($WhatIfOnly) {
  Info "[whatif] dsh plugin --profile $Profile add `"$PluginDir`""
} else {
  & dsh plugin --profile $Profile add $PluginDir
  # Deliberately not checking $LASTEXITCODE: dsh exits 0 even when it fails to
  # register the bundle. Everything is verified below instead.
}

Step "2/5 profile manifest"
if (-not (Test-Path $profileManifestPath)) { throw "profile manifest missing: $profileManifestPath" }
$pm = Get-Content $profileManifestPath -Raw | ConvertFrom-Json
$depSpec = $null
if ($pm.dependencies -and $pm.dependencies.PSObject.Properties[$pkgName]) {
  $depSpec = $pm.dependencies.$pkgName
}
Info ("dependency : " + $(if ($depSpec) { $depSpec } else { '(MISSING)' }))
if (-not $depSpec) {
  throw "dsh did not record the dependency; run the command manually and read its output"
}

Step "3/5 link"
$linkOk = $false
$linkKind = '(absent)'
$linkTarget = ''
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  $linkKind = $item.LinkType
  $linkTarget = [string]$item.Target
  Info ("kind       : " + $linkKind)
  Info ("target     : " + $linkTarget)
  $linkOk = Test-Path -LiteralPath (Join-Path $linkPath 'package.json')
}
Info ("resolves   : " + $linkOk)

if ($linkOk) {
  Info "link is fine."
} else {
  Info "link is BROKEN -> repairing."
  if ($WhatIfOnly) {
    Info "[whatif] remove the bad link and recreate it pointing at $PluginDir"
  } else {
    if (Test-Path -LiteralPath $linkPath) {
      $item = Get-Item -LiteralPath $linkPath -Force
      # ONLY ever remove a reparse point. Remove-Item -Recurse on a junction in
      # PS 5.1 follows the link and deletes the TARGET's contents - i.e. it would
      # wipe the plugin source tree.
      if ($item.LinkType -ne 'Junction' -and $item.LinkType -ne 'SymbolicLink') {
        throw "$linkPath exists and is a real directory, not a link - refusing to delete it. Inspect it by hand."
      }
      [System.IO.Directory]::Delete($linkPath, $false)
      Info "removed the bad link (source tree untouched)"
    }
    $parent = Split-Path -Parent $linkPath
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    New-Item -ItemType Junction -Path $linkPath -Target $PluginDir | Out-Null
    Info ("recreated -> " + ([string](Get-Item -LiteralPath $linkPath -Force).Target))
    $linkOk = Test-Path -LiteralPath (Join-Path $linkPath 'package.json')
    Info ("resolves   : " + $linkOk)
    if (-not $linkOk) { throw "repair did not take; inspect $linkPath by hand" }
  }
}

Step "4/5 dsh.profile.bundles"
$bundles = @()
if ($pm.dsh -and $pm.dsh.profile -and $pm.dsh.profile.bundles) { $bundles = @($pm.dsh.profile.bundles) }
Info ("bundles    : " + ($bundles -join ', '))
if ($bundles -contains $pkgName) {
  Info "already registered as a bundle."
} else {
  Info "NOT registered -> adding (dsh would have skipped it while the link was broken)."
  if ($WhatIfOnly) {
    Info "[whatif] append '$pkgName' to dsh.profile.bundles"
  } else {
    $bundles = @($bundles) + $pkgName
    if (-not $pm.dsh) { $pm | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
    if (-not $pm.dsh.profile) {
      $pm.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
    }
    $pm.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    $json = $pm | ConvertTo-Json -Depth 12
    # WriteAllText emits UTF-8 with NO BOM; a BOM would break JSON.parse in dsh.
    [System.IO.File]::WriteAllText($profileManifestPath, $json)
    Info "written. bundles now: $($bundles -join ', ')"
  }
}

Step "5/5 verify with --dump-config"
if ($WhatIfOnly) {
  Info "[whatif] dsh --profile $Profile --dump-config | select-string $pkgName"
} else {
  $dump = (& dsh --profile $Profile --dump-config 2>&1 | Out-String)
  if ($dump -match [regex]::Escape($pkgName)) {
    Info "OK: $pkgName is in the composed profile tree."
    ($dump -split "`r?`n") | Where-Object { $_ -match [regex]::Escape($pkgName) } | ForEach-Object { Info ("   " + $_.Trim()) }
    Info ""
    Info "Next: restart dsh (a NEW bundle is only picked up at boot; the patch file is"
    Info "hot-reloaded, but dsh.profile.bundles is read once at startup), then refresh"
    Info "the browser page so the client half is loaded too."
  } else {
    throw "$pkgName is still not in the composed tree - install did not succeed"
  }
}

Write-Host ""
Write-Host "DONE"

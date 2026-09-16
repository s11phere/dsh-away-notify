# focus-or-open.ps1 - one-shot handler for the dshnotify: protocol.
#
# This is the FALLBACK path. A click normally goes through enqueue-focus.vbs ->
# the resident focus-helper.ps1, because a cold PowerShell costs ~2s (see the
# README section on click latency). This script is still what runs when the
# helper is unavailable, and it is also handy for manual testing:
#
#   powershell -File focus-or-open.ps1 -Uri "dshnotify:<base64url>" `
#       -Marker "DeepSeek Harness" -TagMode port
#
# The actual behaviour lives in focus-lib.ps1, shared with the helper so the
# fast path and the fallback can never drift apart.
#
# THIS FILE MUST STAY PURE ASCII (see focus-lib.ps1 for why).

param(
  [Parameter(Mandatory = $true)][string]$Uri,
  [string]$Marker = 'DeepSeek Harness',
  [string]$TagMode = 'port'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'focus-lib.ps1')

$status = Invoke-DshFocus -Uri $Uri -Marker $Marker -TagMode $TagMode
Write-Output $status

if ($status.Contains('FOCUSED') -or $status.Contains('OPENED')) { exit 0 }
exit 1

# focus-helper.ps1 - resident focus helper for dsh-away-notify.
#
# Started once by the plugin (lib/host.js) when the profile loads. It stays
# alive so that the expensive parts of the focus path are paid once instead of
# per click:
#   * the PowerShell process itself      (~950ms per cold start)
#   * Add-Type compiling the P/Invoke block (~285ms)
#   * cold assembly loads for the process enumeration (~200ms)
#
# Clicks are handled by scripts/enqueue-focus.vbs, which just drops a request
# file into the spool directory and exits. This helper is woken by a
# FileSystemWatcher, so the reaction is immediate and the idle cost is ~0% CPU
# (a polling loop would burn 10-25% of a core to be slower than this).
#
# Request format: spool/req-*.txt, up to three lines - the dshnotify: URI, the
# window marker, and the tag mode. Deleted as soon as it has been read.
# Lifecycle: spool/stop exists -> exit. spool/heartbeat is touched every loop so
# the enqueuer can tell a live helper from a dead one.
#
# THIS FILE MUST STAY PURE ASCII (see focus-lib.ps1 for why).

param(
  [Parameter(Mandatory = $true)][string]$SpoolDir,
  [int]$WaitMs = 1000
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'focus-lib.ps1')

# Single instance: a reload can race a still-running helper, and the loser must
# not start processing the same requests.
$mutex = New-Object System.Threading.Mutex($false, 'Local\dsh-away-notify-focus-helper')
$ownsMutex = $false
try { $ownsMutex = $mutex.WaitOne(0) } catch { $ownsMutex = $false }
if (-not $ownsMutex) { exit 0 }

if (-not (Test-Path -LiteralPath $SpoolDir)) {
  New-Item -ItemType Directory -Path $SpoolDir -Force | Out-Null
}

$stopFile = Join-Path $SpoolDir 'stop'
$heartbeat = Join-Path $SpoolDir 'heartbeat'
$statusFile = Join-Path $SpoolDir 'last-status.txt'
# A stale stop file from a previous run must not kill this one immediately.
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $SpoolDir
$watcher.Filter = 'req-*.txt'
$watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName
$watcher.IncludeSubdirectories = $false
$watcher.EnableRaisingEvents = $true

function Write-Status([string]$text) {
  try { [System.IO.File]::WriteAllText($statusFile, $text) } catch { }
}

try {
  while (-not (Test-Path -LiteralPath $stopFile)) {
    # Drain everything pending; the watcher only tells us *that* something
    # arrived, and a drained directory also recovers from buffer overflows.
    $requests = @()
    try {
      $requests = @(Get-ChildItem -LiteralPath $SpoolDir -Filter 'req-*.txt' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime, Name)
    } catch { }

    foreach ($request in $requests) {
      $uri = ''
      $marker = 'DeepSeek Harness'
      $tagMode = 'port'
      try {
        $lines = @(Get-Content -LiteralPath $request.FullName -ErrorAction SilentlyContinue)
        if ($lines.Count -ge 1) { $uri = [string]$lines[0] }
        if ($lines.Count -ge 2) { $marker = [string]$lines[1] }
        if ($lines.Count -ge 3) { $tagMode = [string]$lines[2] }
      } catch { }
      Remove-Item -LiteralPath $request.FullName -Force -ErrorAction SilentlyContinue
      if ($uri.Length -gt 0) {
        Write-Status (Invoke-DshFocus -Uri $uri -Marker $marker -TagMode $tagMode)
      }
    }

    try { [System.IO.File]::WriteAllText($heartbeat, [string][DateTime]::UtcNow.Ticks) } catch { }
    $null = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, $WaitMs)
  }
} finally {
  $watcher.EnableRaisingEvents = $false
  $watcher.Dispose()
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $heartbeat -Force -ErrorAction SilentlyContinue
  try { $mutex.ReleaseMutex() } catch { }
  try { $mutex.Dispose() } catch { }
}

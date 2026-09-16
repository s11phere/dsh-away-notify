# focus-lib.ps1 - shared "bring the right dsh browser window forward" logic.
#
# Dot-sourced by two entry points so they can never drift apart:
#   * focus-or-open.ps1 - one-shot handler; the cold-PowerShell fallback path
#   * focus-helper.ps1  - resident helper started at plugin load; the fast path
#
# A one-shot PowerShell costs ~2s per click: process start (~950ms) + Add-Type
# compiling the P/Invoke block (~285ms) + cold assembly loads. Resident, the
# helper pays all of that once. Measured breakdown lives in the README section
# on click latency.
#
# THIS FILE MUST STAY PURE ASCII: Windows PowerShell 5.1 reads a .ps1 without a
# BOM using the ANSI code page, and any non-ASCII character makes it fail to
# parse the whole script.

# Literal, case-insensitive substring match.
#
# NOT `-like`: the instance tag looks like "[dsh:3081]", and in a -like pattern
# the brackets are a character *set* - "*[dsh:3080]*" matches almost any title
# (it only needs one of d/s/h/:/3/0/8), silently defeating the instance filter.
# Verified on a real machine.
function Test-TitleContains {
  param([string]$Haystack, [string]$Needle)
  if ([string]::IsNullOrEmpty($Needle)) { return $true }
  if ([string]::IsNullOrEmpty($Haystack)) { return $false }
  return $Haystack.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

# Guarded so dot-sourcing this library twice in one process is a no-op rather
# than a "type already exists" error.
if (-not ([System.Management.Automation.PSTypeName]'DshNotify.Native').Type) {
  Add-Type -Namespace DshNotify -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
'@
}

function Focus-DshWindow {
  param([IntPtr]$Handle)
  if ([DshNotify.Native]::IsIconic($Handle)) { [void][DshNotify.Native]::ShowWindow($Handle, 9) }
  $foreground = [DshNotify.Native]::GetForegroundWindow()
  $foreignPid = 0
  $foreignThread = [DshNotify.Native]::GetWindowThreadProcessId($foreground, [ref]$foreignPid)
  $ownThread = [DshNotify.Native]::GetCurrentThreadId()
  # The foreground lock makes SetForegroundWindow fail unless the caller owns
  # the current foreground window; attaching to that thread's input queue first
  # makes it succeed far more reliably.
  [void][DshNotify.Native]::AttachThreadInput($ownThread, $foreignThread, $true)
  [void][DshNotify.Native]::BringWindowToTop($Handle)
  $ok = [DshNotify.Native]::SetForegroundWindow($Handle)
  [void][DshNotify.Native]::AttachThreadInput($ownThread, $foreignThread, $false)
  return $ok
}

# Decode dshnotify:<base64url> into the target URL. base64 keeps `&`, quotes and
# `%` from being mangled on the command line -> registry -> ShellExecute chain.
function ConvertFrom-DshnotifyUri {
  param([string]$Uri)
  $payload = [string]$Uri
  if ($payload.StartsWith('dshnotify:')) { $payload = $payload.Substring(10) }
  $payload = $payload.TrimStart('/')
  $b64 = $payload.Replace('-', '+').Replace('_', '/')
  switch ($b64.Length % 4) {
    2 { $b64 += '==' }
    3 { $b64 += '=' }
  }
  if ($b64.Length -eq 0) { return '' }
  try {
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  } catch {
    return ''
  }
}

# The target URL carries the port, and the client half titles its tab with the
# matching "[dsh:<port>]" tag, so the tag can be rebuilt here without any extra
# state on the command line or in the registry.
function Get-DshInstanceTag {
  param([string]$Url, [string]$TagMode)
  if ($TagMode -ne 'port') { return '' }
  if ([string]::IsNullOrEmpty($Url)) { return '' }
  $port = 0
  try { $port = ([Uri]$Url).Port } catch { $port = 0 }
  if ($port -gt 0) { return '[dsh:' + $port + ']' }
  return ''
}

# Enumerate the three Chromium/Firefox families and pick the window whose title
# holds both the marker and (when tag mode is on) this instance's port tag.
function Find-DshWindow {
  param([string]$Marker, [string]$Tag)
  $candidates = @()
  foreach ($procName in @('msedge', 'chrome', 'firefox')) {
    $candidates += [System.Diagnostics.Process]::GetProcessesByName($procName)
  }
  $windows = @($candidates | Where-Object { $null -ne $_ -and $_.MainWindowHandle -ne 0 })
  $byMarker = @($windows | Where-Object { Test-TitleContains $_.MainWindowTitle $Marker })
  $target = $null
  if ([string]::IsNullOrEmpty($Tag)) {
    $target = $byMarker | Select-Object -First 1
  } else {
    $target = $byMarker | Where-Object { Test-TitleContains $_.MainWindowTitle $Tag } | Select-Object -First 1
  }
  return [pscustomobject]@{ Target = $target; MarkerCount = $byMarker.Count }
}

# The whole handler. Returns a single ASCII status line (the helper records it
# for diagnostics, the one-shot fallback prints it) and never throws.
function Invoke-DshFocus {
  param(
    [string]$Uri,
    [string]$Marker = 'DeepSeek Harness',
    [string]$TagMode = 'port',
    [bool]$OpenFallback = $true
  )
  try {
    $url = ConvertFrom-DshnotifyUri -Uri $Uri
    $tag = Get-DshInstanceTag -Url $url -TagMode $TagMode

    $found = Find-DshWindow -Marker $Marker -Tag $tag
    if ($null -ne $found.Target) {
      $ok = Focus-DshWindow -Handle $found.Target.MainWindowHandle
      return 'FOCUSED hwnd=' + $found.Target.MainWindowHandle + ' ok=' + $ok + ' tag=' + $tag
    }

    # Distinguish "the marker matched nothing" from "it matched, but not this
    # instance" - the latter is exactly what the port tag exists to catch.
    $why = 'NO_WINDOW'
    if (-not [string]::IsNullOrEmpty($tag)) {
      $why = 'TAG_MISS tag=' + $tag + ' marker_windows=' + $found.MarkerCount
    }

    if ($OpenFallback -and -not [string]::IsNullOrEmpty($url)) {
      Start-Process $url | Out-Null
      return $why + ' OPENED'
    }
    return $why
  } catch {
    return 'ERROR ' + $_.Exception.Message
  }
}

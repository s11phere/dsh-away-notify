# focus-lib.ps1 - shared "bring the right dsh browser window forward" logic.
#
# Dot-sourced by two entry points so they can never drift apart:
#   * focus-or-open.ps1 - one-shot handler; the cold-PowerShell fallback path
#   * focus-helper.ps1  - resident helper started at plugin load; the fast path
#
# A one-shot PowerShell costs ~2s per click: process start (~950ms) + Add-Type
# compiling the P/Invoke block (~285ms) + window lookup. Resident, the helper pays
# the first two once. The window lookup itself used to dominate what was left
# (Process.GetProcessesByName x3 = 0.45-0.65s); it is now a single EnumWindows pass
# (single-digit ms). Measured breakdown lives in the README section on click latency.
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
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
// One EnumWindows pass, "hwnd<TAB>pid<TAB>title" per visible titled window.
//
// Why not Process.GetProcessesByName: a single call already enumerates *every*
// process (148-213ms measured on a 400-process machine) and the old code called it
// three times per click (msedge/chrome/firefox). EnumWindows walks only top-level
// windows and costs single-digit ms, so the click path stops paying for a process
// sweep. Matching stays by window title (see Test-TitleContains).
public static string[] ListWindowTitles() {
  System.Collections.Generic.List<string> list = new System.Collections.Generic.List<string>();
  EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd)) { return true; }
    int len = GetWindowTextLength(hWnd);
    if (len <= 0) { return true; }
    System.Text.StringBuilder sb = new System.Text.StringBuilder(len + 1);
    GetWindowText(hWnd, sb, sb.Capacity);
    string title = sb.ToString();
    if (title.Length == 0) { return true; }
    uint pid = 0;
    GetWindowThreadProcessId(hWnd, out pid);
    list.Add(hWnd.ToInt64().ToString() + "\t" + pid.ToString() + "\t" + title);
    return true;
  }, IntPtr.Zero);
  return list.ToArray();
}
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

# Last window we matched, keyed by "marker|tag".
#
# The OS window title only reflects the browser's *active* tab, so as soon as the
# user switches to another tab the marker and the instance tag vanish from the
# title and matching fails - which used to mean a duplicate tab got opened. Keeping
# the last match lets a later click still bring the right window forward. This
# matters most with several dsh instances: only one of their tabs can be active, so
# for the others title matching always fails.
if ($null -eq $script:DshWindowCache) { $script:DshWindowCache = @{} }

# Pick the window whose title holds both the marker and (when tag mode is on) this
# instance's port tag. Titles come from one EnumWindows pass; matching is literal
# (see Test-TitleContains). Returns the handle, not a Process object, so nothing
# here has to enumerate processes.
function Find-DshWindow {
  param([string]$Marker, [string]$Tag)
  $byMarker = @()
  foreach ($line in [DshNotify.Native]::ListWindowTitles()) {
    # Split into hwnd / pid / title with a limit so tabs inside a title survive.
    $parts = $line.Split([char]9, 3)
    if ($parts.Length -lt 3) { continue }
    $title = $parts[2]
    if (Test-TitleContains $title $Marker) {
      $byMarker += [pscustomobject]@{ Handle = [IntPtr]([long]$parts[0]); Pid = [int]$parts[1]; Title = $title }
    }
  }
  $target = $null
  if ([string]::IsNullOrEmpty($Tag)) {
    $target = $byMarker | Select-Object -First 1
  } else {
    $target = $byMarker | Where-Object { Test-TitleContains $_.Title $Tag } | Select-Object -First 1
  }
  $key = $Marker + '|' + $Tag
  if ($null -ne $target) {
    $script:DshWindowCache[$key] = $target.Handle
    return [pscustomobject]@{ Target = $target; MarkerCount = $byMarker.Count; FromCache = $false }
  }
  # Title miss: the dsh tab is most likely just not the active one anymore, so fall
  # back to the window we matched last time instead of opening a duplicate tab.
  $cached = $script:DshWindowCache[$key]
  if ($null -ne $cached -and [DshNotify.Native]::IsWindow($cached)) {
    $fallback = [pscustomobject]@{ Handle = $cached; Pid = 0; Title = '(last matched window)' }
    return [pscustomobject]@{ Target = $fallback; MarkerCount = $byMarker.Count; FromCache = $true }
  }
  return [pscustomobject]@{ Target = $null; MarkerCount = $byMarker.Count; FromCache = $false }
}

# Find, via UI Automation, the browser tab that holds this instance's dsh page, and
# select it.
#
# Why this exists: the OS window title only reflects the browser's *active* tab, so
# as soon as the user switches to another tab the marker and the port tag vanish from
# the title and title matching fails. Chromium and Firefox do expose every tab as a
# UI Automation TabItem, titled with that tab's own page title - so the tab can still
# be found and selected, which is what actually brings the dsh page back. Focusing a
# window alone would leave the user on whatever tab was showing.
#
# @returns {Hwnd, Selected} of the matching tab, or $null when there is none.
function Select-DshTab {
  param(
    [string]$Marker,
    [string]$Tag,
    [IntPtr]$PreferHandle = [IntPtr]::Zero
  )
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
  } catch {
    return $null
  }
  $tabCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem)

  # The window we matched last time first (cheap), then every other visible window.
  $candidates = New-Object System.Collections.ArrayList
  if ($PreferHandle -ne [IntPtr]::Zero) { [void]$candidates.Add($PreferHandle) }
  foreach ($line in [DshNotify.Native]::ListWindowTitles()) {
    $parts = $line.Split([char]9, 3)
    if ($parts.Length -lt 3) { continue }
    $handle = [IntPtr]([long]$parts[0])
    if ($handle -eq $PreferHandle) { continue }
    [void]$candidates.Add($handle)
  }

  foreach ($handle in $candidates) {
    $root = $null
    try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch { continue }
    if ($null -eq $root) { continue }
    $className = ''
    try { $className = [string]$root.Current.ClassName } catch { continue }
    # Only these expose tabs as TabItems; skip everything else without a tree walk.
    $isBrowser = $false
    if ($className.IndexOf('Chrome_WidgetWin', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $isBrowser = $true }
    if ($className.IndexOf('MozillaWindowClass', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $isBrowser = $true }
    if (-not $isBrowser) { continue }
    $tabs = $null
    try { $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition) } catch { continue }
    foreach ($tab in $tabs) {
      $name = ''
      try { $name = [string]$tab.Current.Name } catch { continue }
      if (-not (Test-TitleContains $name $Marker)) { continue }
      if (-not [string]::IsNullOrEmpty($Tag) -and -not (Test-TitleContains $name $Tag)) { continue }
      $pattern = $null
      $selected = $false
      try {
        if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
          $pattern.Select()
          $selected = $true
        } elseif ($tab.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
          $pattern.Invoke()
          $selected = $true
        }
      } catch { }
      return [pscustomobject]@{ Hwnd = $handle; Selected = $selected }
    }
  }
  return $null
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

    # Fast path: the window title already carries this instance's marker + tag, so
    # the dsh tab IS the active one and focusing the window is enough.
    $found = Find-DshWindow -Marker $Marker -Tag $tag
    if ($null -ne $found.Target -and -not $found.FromCache) {
      $ok = Focus-DshWindow -Handle $found.Target.Handle
      return 'FOCUSED hwnd=' + $found.Target.Handle + ' ok=' + $ok + ' tag=' + $tag
    }

    # The dsh tab is not the active one. Ask UI Automation for the tab itself and
    # select it: focusing the window alone would leave the user on whatever tab was
    # showing (and used to open a duplicate tab instead).
    $prefer = [IntPtr]::Zero
    if ($null -ne $found.Target) { $prefer = $found.Target.Handle }
    $tab = Select-DshTab -Marker $Marker -Tag $tag -PreferHandle $prefer
    if ($null -ne $tab) {
      $ok = Focus-DshWindow -Handle $tab.Hwnd
      $script:DshWindowCache[$Marker + '|' + $tag] = $tab.Hwnd
      $extra = ''
      if (-not $tab.Selected) { $extra = ' NOT_SELECTED' }
      return 'TAB_FOCUSED hwnd=' + $tab.Hwnd + ' ok=' + $ok + ' tag=' + $tag + $extra
    }

    # No tab anywhere: keep the last matched window (never a duplicate tab) ...
    if ($null -ne $found.Target) {
      $ok = Focus-DshWindow -Handle $found.Target.Handle
      return 'FOCUSED hwnd=' + $found.Target.Handle + ' ok=' + $ok + ' tag=' + $tag + ' CACHED'
    }

    # ... and only then open the URL. Distinguish "the marker matched nothing" from
    # "it matched, but not this instance" - the latter is what the port tag catches.
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

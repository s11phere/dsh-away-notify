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
# THREE ways a click can reach the dsh page, in order:
#   1. the window title already holds marker + tag -> the dsh tab IS active, focus
#      the window (Find-DshWindow + Focus-DshWindow);
#   2. the dsh tab is in the background -> UI Automation finds the browser's TabItem
#      and selects it (Get-DshTabCandidates + Select-DshTabItem). A minimized
#      Chromium window exposes NO TabItem at all, so the known window is restored
#      first (Restore-DshWindow) and the search is retried;
#   3. nothing selectable -> focus the known window and open the URL, so a click
#      never strands you on whatever tab was showing.
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

# Undo SW_MINIMIZE (9 = SW_RESTORE). Returns $true when the window had been
# minimized. Restoring also activates the window, which is what makes the browser
# publish its tab strip to UI Automation again.
#
# Measured on Edge 153 / Windows 10: a minimized Chromium window exposes
# FromHandle fine but FindAll(Descendants, TabItem) returns 0 tabs (probed twice,
# 24-36ms each); after SW_RESTORE the same window exposes its 2 TabItems ~95ms
# later. That is the whole "click only focuses the window and leaves the previous
# tab showing" bug: the tab search could not see anything to select.
function Restore-DshWindow {
  param([IntPtr]$Handle)
  if (-not [DshNotify.Native]::IsIconic($Handle)) { return $false }
  [void][DshNotify.Native]::ShowWindow($Handle, 9)
  return $true
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
# Where to persist that cache, when the caller has a spool directory (the resident
# helper does). The in-memory map dies with the process, and the helper is
# restarted by every plugin load / dsh restart; without the file, the first click
# after a restart cannot tell which browser window belongs to this instance, so a
# minimized browser would end up with a duplicate tab instead of the right one.
if ($null -eq $script:DshWindowCacheFile) { $script:DshWindowCacheFile = '' }
if ($null -eq $script:DshWindowCacheLoaded) { $script:DshWindowCacheLoaded = $false }
if ($null -eq $script:DshWindowCacheDirty) { $script:DshWindowCacheDirty = $false }
if ($null -eq $script:UiaReady) { $script:UiaReady = $null }

function Set-DshWindowCacheFile {
  param([string]$Path)
  $script:DshWindowCacheFile = [string]$Path
  $script:DshWindowCacheLoaded = $false
}

function Set-DshWindowCacheEntry {
  param([string]$Key, [IntPtr]$Handle)
  if ($script:DshWindowCache.ContainsKey($Key)) {
    if ($script:DshWindowCache[$Key] -ne $Handle) { $script:DshWindowCacheDirty = $true }
  } else {
    $script:DshWindowCacheDirty = $true
  }
  $script:DshWindowCache[$Key] = $Handle
}

function Remove-DshWindowCacheEntry {
  param([string]$Key)
  if ($script:DshWindowCache.ContainsKey($Key)) {
    [void]$script:DshWindowCache.Remove($Key)
    $script:DshWindowCacheDirty = $true
  }
}

# Read "<marker>|<tag><TAB><hwnd>" lines once per process. Dead handles are
# dropped on use (Find-DshWindow checks IsWindow), not here.
function Import-DshWindowCache {
  if ($script:DshWindowCacheLoaded) { return }
  $script:DshWindowCacheLoaded = $true
  if ([string]::IsNullOrEmpty($script:DshWindowCacheFile)) { return }
  try {
    if (-not (Test-Path -LiteralPath $script:DshWindowCacheFile)) { return }
    foreach ($raw in @(Get-Content -LiteralPath $script:DshWindowCacheFile -ErrorAction SilentlyContinue)) {
      $line = [string]$raw
      if ($line.Length -eq 0) { continue }
      $parts = $line.Split([char]9)
      if ($parts.Length -lt 2) { continue }
      $value = [long]0
      if (-not [long]::TryParse($parts[1], [ref]$value)) { continue }
      if ($value -le 0) { continue }
      $script:DshWindowCache[$parts[0]] = [IntPtr]$value
    }
  } catch {
  }
}

# Atomic-ish rewrite (temp name + move) and prune handles whose window is gone.
function Save-DshWindowCache {
  if (-not $script:DshWindowCacheDirty) { return }
  if ([string]::IsNullOrEmpty($script:DshWindowCacheFile)) { return }
  try {
    $lines = @()
    foreach ($key in @($script:DshWindowCache.Keys)) {
      $handle = [IntPtr]$script:DshWindowCache[$key]
      if (-not [DshNotify.Native]::IsWindow($handle)) {
        [void]$script:DshWindowCache.Remove($key)
        continue
      }
      $lines += ($key + [char]9 + ([long]$handle).ToString())
    }
    $tmp = $script:DshWindowCacheFile + '.tmp'
    [System.IO.File]::WriteAllLines($tmp, [string[]]$lines, [System.Text.Encoding]::ASCII)
    Move-Item -LiteralPath $tmp -Destination $script:DshWindowCacheFile -Force
    $script:DshWindowCacheDirty = $false
  } catch {
  }
}

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
    Set-DshWindowCacheEntry -Key $key -Handle $target.Handle
    return [pscustomobject]@{ Target = $target; MarkerCount = $byMarker.Count; FromCache = $false }
  }
  # Title miss: the dsh tab is most likely just not the active one anymore, so fall
  # back to the window we matched last time instead of opening a duplicate tab.
  Import-DshWindowCache
  $cached = $script:DshWindowCache[$key]
  if ($null -ne $cached -and [DshNotify.Native]::IsWindow($cached)) {
    $fallback = [pscustomobject]@{ Handle = $cached; Pid = 0; Title = '(last matched window)' }
    return [pscustomobject]@{ Target = $fallback; MarkerCount = $byMarker.Count; FromCache = $true }
  }
  return [pscustomobject]@{ Target = $null; MarkerCount = $byMarker.Count; FromCache = $false }
}

# Only these window classes expose browser tabs as UIA TabItems; everything else
# (including Electron apps such as VS Code, which share Chrome_WidgetWin) is
# skipped before a tree walk.
function Test-BrowserClassName {
  param([string]$ClassName)
  if ([string]::IsNullOrEmpty($ClassName)) { return $false }
  if ($ClassName.IndexOf('Chrome_WidgetWin', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  if ($ClassName.IndexOf('MozillaWindowClass', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  return $false
}

# Load the UIA client assemblies once per process (the resident helper pays it at
# first use; a cold one-shot pays it as before).
function Initialize-Uia {
  if ($null -ne $script:UiaReady) { return [bool]$script:UiaReady }
  $script:UiaReady = $false
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
    $script:UiaReady = $true
  } catch {
    $script:UiaReady = $false
  }
  return [bool]$script:UiaReady
}

# UI Automation candidates, the window we matched last time first (cheap), then
# every other visible window.
function Get-UiaCandidateHandles {
  param([IntPtr]$PreferHandle = [IntPtr]::Zero)
  $candidates = New-Object System.Collections.ArrayList
  if ($PreferHandle -ne [IntPtr]::Zero) { [void]$candidates.Add($PreferHandle) }
  foreach ($line in [DshNotify.Native]::ListWindowTitles()) {
    $parts = $line.Split([char]9, 3)
    if ($parts.Length -lt 3) { continue }
    $handle = [IntPtr]([long]$parts[0])
    if ($handle -eq $PreferHandle) { continue }
    [void]$candidates.Add($handle)
  }
  return $candidates
}

# Find, via UI Automation, the browser tab(s) that hold this instance's dsh page.
#
# Why this exists: the OS window title only reflects the browser's *active* tab, so
# as soon as the user switches to another tab the marker and the port tag vanish from
# the title and title matching fails. Chromium and Firefox do expose every tab as a
# UI Automation TabItem, titled with that tab's own page title - so the tab can still
# be found and selected, which is what actually brings the dsh page back. Focusing a
# window alone would leave the user on whatever tab was showing.
#
# An empty $Tag asks for the marker-only ("loose") pass: that is how a page whose
# title predates the tag (stale client bundle after an update) can still be found.
#
# @returns ArrayList of { Hwnd, Element, Name }; with -CollectAll every match,
#          otherwise the first one (the hot path must not walk every browser).
function Get-DshTabCandidates {
  param(
    [string]$Marker,
    [string]$Tag,
    [IntPtr]$PreferHandle = [IntPtr]::Zero,
    [switch]$CollectAll,
    [switch]$OnlyPrefer
  )
  $matches = New-Object System.Collections.ArrayList
  if (-not (Initialize-Uia)) { return $matches }
  $tabCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem)
  $handles = @(Get-UiaCandidateHandles -PreferHandle $PreferHandle)
  if ($OnlyPrefer) { $handles = @($PreferHandle) }
  foreach ($handle in $handles) {
    if ($handle -eq [IntPtr]::Zero) { continue }
    $root = $null
    try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch { continue }
    if ($null -eq $root) { continue }
    $className = ''
    try { $className = [string]$root.Current.ClassName } catch { continue }
    if (-not (Test-BrowserClassName $className)) { continue }
    $tabs = $null
    try { $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition) } catch { continue }
    foreach ($tab in $tabs) {
      $name = ''
      try { $name = [string]$tab.Current.Name } catch { continue }
      if (-not (Test-TitleContains $name $Marker)) { continue }
      if (-not [string]::IsNullOrEmpty($Tag) -and -not (Test-TitleContains $name $Tag)) { continue }
      [void]$matches.Add([pscustomobject]@{ Hwnd = $handle; Element = $tab; Name = $name })
      if (-not $CollectAll) { return $matches }
    }
  }
  return $matches
}

# Select one matched tab. Returns $false when no UIA pattern applied (the caller
# still focuses the window, and reports NOT_SELECTED for diagnostics).
function Select-DshTabItem {
  param($Match)
  if ($null -eq $Match) { return $false }
  $pattern = $null
  $selected = $false
  try {
    if ($Match.Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
      $pattern.Select()
      $selected = [bool]$pattern.Current.IsSelected
    } elseif ($Match.Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
      $pattern.Invoke()
      $selected = $true
    }
  } catch {
    $selected = $false
  }
  # Chromium applies the selection slightly asynchronously; one short re-check
  # keeps a successful switch from being reported as NOT_SELECTED.
  if (-not $selected -and $null -ne $pattern) {
    Start-Sleep -Milliseconds 80
    try { $selected = [bool]$pattern.Current.IsSelected } catch { }
  }
  return $selected
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
    $key = $Marker + '|' + $tag
    Import-DshWindowCache

    # Fast path: the window title already carries this instance's marker + tag, so
    # the dsh tab IS the active one and focusing the window is enough.
    $found = Find-DshWindow -Marker $Marker -Tag $tag
    if ($null -ne $found.Target -and -not $found.FromCache) {
      $ok = Focus-DshWindow -Handle $found.Target.Handle
      Save-DshWindowCache
      return 'FOCUSED hwnd=' + $found.Target.Handle + ' ok=' + $ok + ' tag=' + $tag
    }

    # The dsh tab is not the active one. We usually know which window it belongs to
    # (the cache), and a MINIMIZED Chromium window exposes no TabItem at all, so
    # restore it before asking UI Automation for the tab. Restoring also activates
    # the window; the browser publishes its tab strip ~100ms later, which is what
    # the retry loop below waits for.
    $prefer = [IntPtr]::Zero
    $restored = $false
    $uiaReady = Initialize-Uia
    if ($null -ne $found.Target) {
      $prefer = $found.Target.Handle
      if ($uiaReady) {
        $className = Get-WindowClassName -Handle $prefer
        if (-not (Test-BrowserClassName $className)) {
          # The cached handle no longer points at a browser window (it was recycled
          # after the browser closed): forget it instead of restoring a stranger.
          Remove-DshWindowCacheEntry -Key $key
          Save-DshWindowCache
          $prefer = [IntPtr]::Zero
        } elseif ([DshNotify.Native]::IsIconic($prefer)) {
          $restored = Restore-DshWindow -Handle $prefer
        }
      } elseif ([DshNotify.Native]::IsIconic($prefer)) {
        # No UI Automation here (assembly missing / policy): we cannot verify the
        # handle by class, but a window we matched before still beats a duplicate tab.
        $restored = Restore-DshWindow -Handle $prefer
      }
    }

    $attempts = 1
    if ($restored) { $attempts = 5 } elseif ($null -ne $found.Target) { $attempts = 2 }
    $used = 0
    $tab = $null
    for ($i = 1; $i -le $attempts; $i++) {
      $used = $i
      # @() keeps a one-element result scalar-safe (a bare ArrayList return gets
      # unrolled by the pipeline, and a scalar has no .Count).
      $match = @(Get-DshTabCandidates -Marker $Marker -Tag $tag -PreferHandle $prefer)
      if ($match.Count -gt 0) { $tab = $match[0]; break }
      if ($i -lt $attempts) { Start-Sleep -Milliseconds 120 }
    }

    if ($null -ne $tab) {
      $selected = Select-DshTabItem -Match $tab
      $ok = Focus-DshWindow -Handle $tab.Hwnd
      Set-DshWindowCacheEntry -Key $key -Handle $tab.Hwnd
      Save-DshWindowCache
      $extra = ''
      if ($restored) { $extra += ' RESTORED' }
      if ($used -gt 1) { $extra += ' retry=' + $used }
      if (-not $selected) { $extra += ' NOT_SELECTED' }
      return 'TAB_FOCUSED hwnd=' + $tab.Hwnd + ' ok=' + $ok + ' tag=' + $tag + $extra
    }

    # No tab matched marker + tag. A page loaded before the title tag existed (the
    # old client bundle survives in an open tab until the page is refreshed) still
    # matches the marker alone. Look for it ONLY inside the window we already know
    # to be this instance's: a global marker-only search would happily land on a
    # second dsh instance's tab whenever this instance's own window is invisible to
    # UI Automation (measured: a minimized window exposes no TabItem at all, so the
    # "unique marker match" would be the *other* instance).
    if (-not [string]::IsNullOrEmpty($tag) -and $prefer -ne [IntPtr]::Zero) {
      $loose = @(Get-DshTabCandidates -Marker $Marker -Tag '' -PreferHandle $prefer -OnlyPrefer -CollectAll)
      if ($loose.Count -eq 1) {
        $selected = Select-DshTabItem -Match $loose[0]
        $ok = Focus-DshWindow -Handle $loose[0].Hwnd
        Set-DshWindowCacheEntry -Key $key -Handle $loose[0].Hwnd
        Save-DshWindowCache
        $extra = ' NO_TAG'
        if (-not $selected) { $extra += ' NOT_SELECTED' }
        return 'TAB_FOCUSED hwnd=' + $loose[0].Hwnd + ' ok=' + $ok + ' tag=' + $tag + $extra
      }
    }

    # Nothing selectable. Bring the window we know forward (never a duplicate tab
    # while we still know the window), report why, and - unless the operator turned
    # the fallback off - open the URL as well. Leaving the user on whatever tab was
    # showing is the bug this whole file exists to prevent, and an extra tab is the
    # lesser evil.
    $line = ''
    if ($null -ne $found.Target) {
      $ok = Focus-DshWindow -Handle $found.Target.Handle
      $line = 'FOCUSED hwnd=' + $found.Target.Handle + ' ok=' + $ok + ' tag=' + $tag + ' CACHED'
    } else {
      # The cached handle is gone (or was never a browser window): forget it, so the
      # next click starts clean instead of restoring an unrelated window.
      Remove-DshWindowCacheEntry -Key $key
      Save-DshWindowCache
      # Distinguish "the marker matched nothing" from "it matched, but not this
      # instance" - the latter is what the port tag catches.
      $line = 'NO_WINDOW'
      if (-not [string]::IsNullOrEmpty($tag)) {
        $line = 'TAG_MISS tag=' + $tag + ' marker_windows=' + $found.MarkerCount
      }
    }
    if ($OpenFallback -and -not [string]::IsNullOrEmpty($url)) {
      Start-Process $url | Out-Null
      return $line + ' OPENED'
    }
    return $line
  } catch {
    return 'ERROR ' + $_.Exception.Message
  }
}

# Class name of a top-level window handle via UI Automation (used only to sanity
# check a cached handle before restoring it).
function Get-WindowClassName {
  param([IntPtr]$Handle)
  if (-not (Initialize-Uia)) { return '' }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
    if ($null -eq $root) { return '' }
    return [string]$root.Current.ClassName
  } catch {
    return ''
  }
}

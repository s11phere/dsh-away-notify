# focus-or-open.ps1 - handler for the dshnotify: protocol
#
# Invoked by Windows when a toast notification is clicked (registered under
# HKCU\Software\Classes\dshnotify). Behaviour:
#   1. find a browser window whose title contains the DSH marker -> restore if
#      minimized and bring it to the foreground
#   2. none found -> open the target URL with the default browser
#
# The argument is a URI of the form `dshnotify:<base64url>` whose payload is the
# target URL. base64 is used instead of plain text so that `&`, quotes and `%`
# in the URL cannot be mangled between the command line, the registry and
# ShellExecute.
#
# THIS FILE MUST STAY PURE ASCII: Windows PowerShell 5.1 reads a .ps1 without a
# BOM using the ANSI code page, and any non-ASCII character makes it fail to
# parse the whole script.

param(
  [Parameter(Mandatory = $true)][string]$Uri,
  [string]$Marker = 'DeepSeek Harness'
)

$ErrorActionPreference = 'Stop'

# --- decode dshnotify:<base64url> -------------------------------------------
$payload = $Uri
if ($payload.StartsWith('dshnotify:')) { $payload = $payload.Substring(10) }
$payload = $payload.TrimStart('/')
$b64 = $payload.Replace('-', '+').Replace('_', '/')
switch ($b64.Length % 4) {
  2 { $b64 += '==' }
  3 { $b64 += '=' }
}
$url = ''
if ($b64.Length -gt 0) {
  try { $url = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) } catch { $url = '' }
}

# --- Win32 foreground focus --------------------------------------------------s
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

function Focus-Window([IntPtr]$handle) {
  if ([DshNotify.Native]::IsIconic($handle)) { [void][DshNotify.Native]::ShowWindow($handle, 9) }
  $foreground = [DshNotify.Native]::GetForegroundWindow()
  $foreignPid = 0
  $foreignThread = [DshNotify.Native]::GetWindowThreadProcessId($foreground, [ref]$foreignPid)
  $ownThread = [DshNotify.Native]::GetCurrentThreadId()
  # Foreground lock: attaching to the current foreground thread's input queue
  # makes SetForegroundWindow succeed far more reliably.
  [void][DshNotify.Native]::AttachThreadInput($ownThread, $foreignThread, $true)
  [void][DshNotify.Native]::BringWindowToTop($handle)
  $ok = [DshNotify.Native]::SetForegroundWindow($handle)
  [void][DshNotify.Native]::AttachThreadInput($ownThread, $foreignThread, $false)
  return $ok
}

# --- locate a browser window that shows dsh ---------------------------------
$candidates = @()
foreach ($procName in @('msedge', 'chrome', 'firefox')) {
  $candidates += Get-Process -Name $procName -ErrorAction SilentlyContinue
}
$windows = @($candidates | Where-Object { $_.MainWindowHandle -ne 0 })
$target = $windows | Where-Object { $_.MainWindowTitle -like "*$Marker*" } | Select-Object -First 1

if ($null -ne $target) {
  $focused = Focus-Window $target.MainWindowHandle
  Write-Output ('FOCUSED hwnd=' + $target.MainWindowHandle + ' ok=' + $focused)
  exit 0
}

# --- no existing dsh window: hand the URL to the default browser ------------
if ($url.Length -gt 0) {
  Start-Process $url | Out-Null
  Write-Output 'OPENED'
  exit 0
}

Write-Output 'NOOP no-url-no-window'
exit 1

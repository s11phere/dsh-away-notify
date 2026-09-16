' enqueue-focus.vbs - the registered dshnotify: protocol handler.
'
' Runs inside wscript.exe (a GUI-subsystem host), so there is no console flash
' and - crucially - no PowerShell process on the click path. It only drops a
' request file into the helper's spool directory; the resident
' focus-helper.ps1 is woken by a FileSystemWatcher and does the real work.
' That is what turns a ~2s click into a ~0.15s one.
'
' Arguments (from the registered protocol command):
'   0 - the dshnotify: URI
'   1 - spool directory (Windows path)
'
' Everything else (marker, tag mode, helper/fallback script paths) comes from
' config.txt in the spool directory, which the plugin rewrites on every load.
' Reading it per click keeps the registry entry free of instance-specific state
' and lets a config change take effect without restarting the helper.
'
' Safety net: a click can never silently do nothing. If the helper is not alive
' this starts it and then waits long enough for it to boot and drain the request
' (that first click costs the helper's cold start, ~2s, but leaves it warm). If
' the request is still unconsumed after that - a live helper should take ~50ms,
' so only a genuinely broken one gets here - it runs focus-or-open.ps1 directly.
'
' THIS FILE MUST STAY PURE ASCII.

Option Explicit

' A live helper picks the request up in ~50ms; 600ms is already generous.
Const GRACE_LIVE_TICKS = 6
' After starting a cold helper we must outwait its PowerShell start + Add-Type.
Const GRACE_COLD_TICKS = 30
Const TICK_MS = 100
Const HEARTBEAT_STALE_S = 5

Dim shell, fso, args, uri, spool
Dim marker, tagMode, helper, direct, hidden
Dim cfg, ts, line, pos, reqPath, tmpPath, stream
Dim i, ticks, alive, started, wsExe, psExe

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set args = WScript.Arguments
If args.Count < 2 Then WScript.Quit 1
uri = args(0)
spool = args(1)

marker = "DeepSeek Harness"
tagMode = "port"
helper = ""
direct = ""
hidden = ""

' --- config.txt written by the plugin at load -------------------------------
cfg = fso.BuildPath(spool, "config.txt")
If fso.FileExists(cfg) Then
  On Error Resume Next
  Set ts = fso.OpenTextFile(cfg, 1)
  If Err.Number = 0 Then
    Do Until ts.AtEndOfStream
      line = ts.ReadLine
      pos = InStr(line, "=")
      If pos > 0 Then
        Select Case Left(line, pos - 1)
          Case "marker"  marker = Mid(line, pos + 1)
          Case "tagmode" tagMode = Mid(line, pos + 1)
          Case "helper"  helper = Mid(line, pos + 1)
          Case "direct"  direct = Mid(line, pos + 1)
          Case "hidden"  hidden = Mid(line, pos + 1)
        End Select
      End If
    Loop
    ts.Close
  End If
  On Error GoTo 0
End If

' --- helpers ----------------------------------------------------------------
Function Pad10(ByVal s)
  Do While Len(s) < 10
    s = "0" & s
  Loop
  Pad10 = s
End Function

Function HelperAlive()
  HelperAlive = False
  Dim hb, hf
  hb = fso.BuildPath(spool, "heartbeat")
  If Not fso.FileExists(hb) Then Exit Function
  On Error Resume Next
  Set hf = fso.GetFile(hb)
  If Err.Number = 0 Then
    If DateDiff("s", hf.DateLastModified, Now) <= HEARTBEAT_STALE_S Then HelperAlive = True
  End If
  On Error GoTo 0
End Function

' --- drop the request (atomic: write a temp name, then rename) --------------
If Not fso.FolderExists(spool) Then
  On Error Resume Next
  fso.CreateFolder spool
  On Error GoTo 0
End If

Randomize
reqPath = fso.BuildPath(spool, "req-" & Pad10(CStr(CLng(Timer * 1000))) & "-" & Pad10(CStr(Int(Rnd() * 1000000))) & ".txt")
tmpPath = reqPath & ".tmp"

On Error Resume Next
Set stream = fso.CreateTextFile(tmpPath, True)
If Err.Number <> 0 Then WScript.Quit 1
stream.WriteLine uri
stream.WriteLine marker
stream.WriteLine tagMode
stream.Close
fso.MoveFile tmpPath, reqPath
On Error GoTo 0

' --- make sure the helper is running ---------------------------------------
started = False
If Not HelperAlive() Then
  If Len(helper) > 0 And Len(hidden) > 0 Then
    wsExe = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
    On Error Resume Next
    shell.Run """" & wsExe & """ """ & hidden & """ """ & helper & """ -SpoolDir """ & spool & """", 0, False
    On Error GoTo 0
    started = True
  End If
End If

' --- wait for the helper to consume it --------------------------------------
If started Then
  ticks = GRACE_COLD_TICKS
Else
  ticks = GRACE_LIVE_TICKS
End If
For i = 1 To ticks
  WScript.Sleep TICK_MS
  If Not fso.FileExists(reqPath) Then WScript.Quit 0
Next

' --- helper never took it: fall back to the cold one-shot handler -----------
If Len(direct) > 0 Then
  psExe = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
  On Error Resume Next
  fso.DeleteFile reqPath, True
  shell.Run """" & psExe & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & direct & _
            """ -Uri """ & uri & """ -Marker """ & marker & """ -TagMode """ & tagMode & """", 0, False
  On Error GoTo 0
End If

WScript.Quit 0

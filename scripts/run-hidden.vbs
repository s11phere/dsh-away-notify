' run-hidden.vbs - launch the focus-or-open PowerShell script with no console flash.
'
' Why this exists: ShellExecute on powershell.exe always creates a console window
' for a moment, even when -WindowStyle Hidden is passed, so a toast click would
' flash a PowerShell window. wscript.exe is a GUI-subsystem host with no console
' of its own, and WshShell.Run with window style 0 starts PowerShell truly hidden.
'
' Arguments (all supplied by the registered protocol command):
'   0 - path to focus-or-open.ps1
'   1 - the dshnotify: URI
'   2 - optional window-title marker
'
' THIS FILE MUST STAY PURE ASCII.

Option Explicit

Dim shell, args, psScript, targetUri, marker, psExe, cmd
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count < 2 Then
  WScript.Quit 1
End If

psScript = args(0)
targetUri = args(1)
marker = ""
If args.Count > 2 Then marker = args(2)

psExe = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")

cmd = """" & psExe & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & psScript & """ -Uri """ & targetUri & """"
If Len(marker) > 0 Then
  cmd = cmd & " -Marker """ & marker & """"
End If

' 0 = hidden window, False = do not wait for it to finish
shell.Run cmd, 0, False

' run-hidden.vbs - launch a PowerShell script with no console flash.
'
' Why this exists: ShellExecute on powershell.exe always creates a console window
' for a moment, even when -WindowStyle Hidden is passed, so a toast click would
' flash a PowerShell window. wscript.exe is a GUI-subsystem host with no console
' of its own, and WshShell.Run with window style 0 starts PowerShell truly hidden.
'
' Used for two things:
'   * the resident focus helper (focus-helper.ps1), started once at plugin load
'   * the cold one-shot fallback (focus-or-open.ps1), only if the helper is down
'
' Arguments: 0 - path to the .ps1, 1..n - its arguments, passed through verbatim
' (the caller supplies named parameters such as -Uri / -Marker / -TagMode).
'
' THIS FILE MUST STAY PURE ASCII.

Option Explicit

Dim shell, args, psScript, psExe, cmd, i
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count < 1 Then
  WScript.Quit 1
End If

psScript = args(0)
psExe = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")

cmd = """" & psExe & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & psScript & """"
For i = 1 To args.Count - 1
  ' Strip embedded double quotes so a value can never break out of its quoting.
  cmd = cmd & " """ & Replace(args(i), """", "") & """"
Next

' 0 = hidden window, False = do not wait for it to finish
shell.Run cmd, 0, False

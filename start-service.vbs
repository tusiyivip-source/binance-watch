' ============================================================
'  Binance "primary-level pullback structure" monitor (8860)
'  Starts run-service.cmd hidden, from THIS script's own folder
'  (so it can never touch the other instance's directory).
'  ASCII-only on purpose.
' ============================================================
Option Explicit
Dim sh, fso, base, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
cmd = "cmd /c """ & base & "\run-service.cmd"""
sh.Run cmd, 0, False

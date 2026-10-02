@echo off
rem Create the desktop shortcut. Logic lives in tools/make-shortcut.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make-shortcut.ps1" "%~dp0"
pause

@echo off
rem Silent launcher: no console window; serve.py opens the browser itself.
cd /d "%~dp0"
start "" pythonw serve.py

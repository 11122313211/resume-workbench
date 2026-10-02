@echo off
rem Stop the Resume Workbench (kills whatever listens on 127.0.0.1:8618).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8618" ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
powershell -NoProfile -Command "Write-Host ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('566A5Y6G5bel5L2c5Y+w5bey5YGc5q2i44CC')))"
pause

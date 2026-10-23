@echo off
rem Dopamine Center: start the server (double-click). Season continues; prices stay paused while off. Stop: tools\deploy.ps1 -Stop
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1 -SkipPull
pause

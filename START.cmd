@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.22 or newer:
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node apps\cli\wizard.mjs
set exit_code=%errorlevel%
echo.
pause
exit /b %exit_code%

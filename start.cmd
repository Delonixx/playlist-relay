@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer from https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules\@neteasecloudmusicapienhanced\api (
  echo Dependencies are missing. Follow README.md to install them first.
  pause
  exit /b 1
)
node server.mjs
pause

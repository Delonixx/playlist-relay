@echo off
cd /d "%~dp0"
set "PORT=8772"
node server.mjs --demo
pause

@echo off
REM Start the Campus OS server and open the dashboard.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
start "" http://127.0.0.1:4173
node server.js
pause

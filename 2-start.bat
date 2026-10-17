@echo off
cd /d "%~dp0"
if not exist .env (
  echo Run 1-setup.bat first.
  pause
  exit /b 1
)
call npm start
pause

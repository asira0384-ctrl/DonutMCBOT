@echo off
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env
  powershell -NoProfile -Command "(Get-Content .env) -replace 'DATA_DIR=/data', 'DATA_DIR=./data' | Set-Content .env"
)
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
call npm ci --ignore-scripts
if errorlevel 1 goto failed
node scripts/prepare-raknet.js
if errorlevel 1 goto failed
echo Setup complete. Edit .env and run 2-start.bat
notepad .env
pause
exit /b 0
:failed
echo Setup failed. See the error above.
pause
exit /b 1

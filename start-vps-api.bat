@echo off
chcp 65001 >nul
echo ===================================================
echo   STARTING REWARDS CONTROL API ON VPS (PORT 3010)
echo ===================================================
echo.

cd /d "%~dp0"

:: Mo port 3010 trong Windows Firewall tren VPS neu can
powershell -Command "if (!(Get-NetFirewallRule -DisplayName 'Rewards API 3010' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Rewards API 3010' -Direction Inbound -LocalPort 3010 -Protocol TCP -Action Allow }" 2>nul

:: Chay API lang nghe tren 0.0.0.0 de may chinh co the ket noi tu xa
set API_HOST=0.0.0.0
set API_PORT=3010

echo [*] API Backend dang chay tai Port 3010 tren VPS...
echo [*] May tinh chinh co the ket noi toi IP_VPS:3010
echo.
call npm run api
pause

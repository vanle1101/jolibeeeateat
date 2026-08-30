@echo off
chcp 65001 >nul
echo ===================================================
echo   STARTING REWARDS WEB DASHBOARD & CONTROL API
echo ===================================================
echo.

cd /d "%~dp0"

:: 1. Mo port 8890 va 3010 trong Windows Firewall de cho phep may ngoai truy cap
powershell -Command "if (!(Get-NetFirewallRule -DisplayName 'Rewards Web 8890' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Rewards Web 8890' -Direction Inbound -LocalPort 8890 -Protocol TCP -Action Allow }" 2>nul
powershell -Command "if (!(Get-NetFirewallRule -DisplayName 'Rewards API 3010' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Rewards API 3010' -Direction Inbound -LocalPort 3010 -Protocol TCP -Action Allow }" 2>nul

:: 2. Kiem tra neu chua build thi build
if not exist "dist/index.js" (
    echo [*] Dang build du an...
    call npm run build
)

:: 3. Khoi chay Backend API Server (Port 3010)
set API_HOST=0.0.0.0
set API_PORT=3010
echo [*] Dang khoi dong Backend API Server o cong 3010...
start "Rewards API" /min cmd /c "set API_HOST=0.0.0.0&& npm run api"

timeout /t 2 /nobreak >nul

:: 4. Khoi dong Web Dashboard (Port 8890) lang nghe tren 0.0.0.0
set HOST=0.0.0.0
set PORT=8890
echo.
echo ================================================================
echo   DASHBOARD DANG CHAY O CONG 8890!
echo   Ban co the mo trinh duyet tren MAY TINH CHINH truy cap:
echo   ---> http://IP_VPS:8890  (vi du: http://185.34.101.234:8890)
echo ================================================================
echo.

call npm run dashboard
pause

@echo off
chcp 65001 >nul
echo ===================================================
echo   STARTING REWARDS WEB DASHBOARD WITH ONLINE LINK
echo ===================================================
echo.

cd /d "%~dp0"

:: 1. Mo port 8890 va 3010 trong Windows Firewall tren VPS
powershell -Command "if (!(Get-NetFirewallRule -DisplayName 'Rewards Web 8890' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Rewards Web 8890' -Direction Inbound -LocalPort 8890 -Protocol TCP -Action Allow }" 2>nul
powershell -Command "if (!(Get-NetFirewallRule -DisplayName 'Rewards API 3010' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Rewards API 3010' -Direction Inbound -LocalPort 3010 -Protocol TCP -Action Allow }" 2>nul

:: 2. Kiem tra build
if not exist "dist/index.js" (
    echo [*] Dang build du an...
    call npm run build
)

:: 3. Khoi dong API Backend (Port 3010)
set API_HOST=0.0.0.0
set API_PORT=3010
echo [*] Dang khoi dong Backend API Server...
start "Rewards API" /min cmd /c "set API_HOST=0.0.0.0&& npm run api"

timeout /t 2 /nobreak >nul

:: 4. Khoi dong Web Dashboard (Port 8890)
set HOST=0.0.0.0
set PORT=8890
echo [*] Dang khoi dong Web Dashboard...
start "Rewards Dashboard" /min cmd /c "set HOST=0.0.0.0&& set PORT=8890&& npm run dashboard"

timeout /t 2 /nobreak >nul

echo.
echo ================================================================
echo   TAO LINK ONLINE DE TRUY CAP TU MAY CHINH (KHONG LO CHAN PORT)
echo ================================================================
echo [*] Dang tao duong link HTTPS truc tiep bang Cloudflare...
echo.

:: 5. Su dung npx localtunnel hoac untun de tao link HTTPS online
call npx --yes localtunnel --port 8890

pause

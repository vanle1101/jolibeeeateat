@echo off
chcp 65001 >nul
echo ===================================================
echo   STARTING REWARDS WEB DASHBOARD & CONTROL API
echo ===================================================
echo.

cd /d "%~dp0"

:: Kiem tra neu chua build thi build
if not exist "dist/index.js" (
    echo [*] Dang build du an truoc khi chay Dashboard...
    call npm run build
)

:: Khoi chay API Server o background
echo [*] Dang khoi dong Backend API Server (Port 3010)...
start "Rewards API" /min cmd /c "npm run api"

:: Cho API khoi dong 2 giay
timeout /t 2 /nobreak >nul

:: Khoi dong Web Dashboard
echo [*] Dang mo Web Dashboard (Port 8890)...
start http://localhost:8890
call npm run dashboard

pause

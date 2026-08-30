@echo off
chcp 65001 >nul
echo ===================================================
echo   REWARDS LOCAL DASHBOARD (DIEU KHIEN VPS TU XA)
echo ===================================================
echo.

cd /d "%~dp0"

if not exist "local-dashboard\.env" (
    copy local-dashboard\.env.example local-dashboard\.env >nul
    echo [!] Chua co cau hinh IP VPS trong local-dashboard\.env.
    set /p VPS_IP=">>> Nhap IP cua VPS / RDP (vi du: 185.34.101.234): "
    powershell -Command "$c = Get-Content local-dashboard\.env; $c -replace 'YOUR_VPS_HOST', '%VPS_IP%' | Set-Content local-dashboard\.env"
)

echo [*] Dang khoi chay Web Dashboard tai http://localhost:8890...
start http://localhost:8890
call npm run dashboard

pause

@echo off
chcp 65001 >nul
echo ===================================================
echo   AUTO SETUP & RUN MICROSOFT REWARDS SCRIPT (RDP)
echo ===================================================
echo.

cd /d "%~dp0"

:: 1. Kiem tra Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Chua tim thay Node.js. Dang tu dong tai va cai dat Node.js 24...
    powershell -Command "winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements" 2>nul
    where node >nul 2>nul
    if %errorlevel% neq 0 (
        echo [!] Dang tai installer Node.js tu trang chu...
        powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.0.0/node-v24.0.0-x64.msi' -OutFile 'node-installer.msi'"
        msiexec /i node-installer.msi /quiet /norestart
        del node-installer.msi
    )
    echo [*] Da cai xong Node.js! Vui long chay lai file setup.bat neu can nap PATH.
)

echo [*] 1/5. Dang cai dat cac thu vien (npm install)...
call npm install --no-audit --no-fund

echo [*] 2/5. Dang tai trinh duyet tu dong Chromium (Patchright)...
call npx patchright install chromium

echo [*] 3/5. Kiem tra file cau hinh .env va config.json...
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
    ) else (
        type nul > .env
    )
)

findstr /m "ACCOUNTS_DB_KEY" .env >nul 2>nul
if %errorlevel% neq 0 (
    echo [*] Dang tu dong sinh Database Key...
    for /f "tokens=*" %%i in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do (
        echo ACCOUNTS_DB_KEY=%%i>> .env
    )
)

if not exist "config.json" (
    if exist "config.example.json" (
        copy config.example.json config.json >nul
    )
)

echo [*] 4/5. Dang build du an...
call npm run build

echo [*] 5/5. Kiem tra tai khoan...
if exist "accounts.local.txt" (
    echo [*] Dang tu dong import tai khoan tu accounts.local.txt...
    call npm run accounts:import -- ./accounts.local.txt
)

echo.
echo ===================================================
echo   CAI DAT HOAN TAT! DANG KHOI CHAY BOT...
echo ===================================================
echo.
call npm start
pause

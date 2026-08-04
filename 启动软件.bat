@echo off
title Zhi Shi Zhi Hai
cd /d "%~dp0"

echo.
echo === Zhi Shi Zhi Hai ===
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Install failed
        pause
        exit /b 1
    )
)

echo [INFO] Starting server...
start "ZhiShiZhiHai-Server" /MIN node server.js

echo [INFO] Waiting for server...
timeout /t 4 /nobreak >nul

echo [OK] Opening browser...
start "" http://localhost:3000

echo.
echo Server: http://localhost:3000
echo Close this window to stop the server.
echo.
pause

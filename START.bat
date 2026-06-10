@echo off
setlocal enabledelayedexpansion

echo.
echo ============================================
echo CAP Leaflet Editor - Standalone
echo ============================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please download and install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Check if .next directory exists
if not exist ".next" (
    echo ERROR: Application not built. Please run: npm run build
    echo.
    pause
    exit /b 1
)

REM Get local IP
for /f "delims= " %%A in ('powershell -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' -or $_.PrefixOrigin -eq 'Manual' } | Select-Object -First 1).IPAddress"') do (
    set "LOCALIP=%%A"
)

if not defined LOCALIP set "LOCALIP=localhost"

echo Starting server...
echo.
echo ============================================
echo Your application is ready!
echo ============================================
echo.
echo Open in browser:
echo   Local:    http://localhost:3000
echo   Network:  http://!LOCALIP!:3000
echo.
echo To share with customers, give them the Network URL
echo.
echo Press Ctrl+C to stop
echo ============================================
echo.

node server.js

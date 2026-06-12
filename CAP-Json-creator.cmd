@echo off
setlocal enableextensions enabledelayedexpansion

REM CAP Leaflet Editor - Automatic Launcher
REM Always build first to avoid missing CSS/static chunks.

cd /d "%~dp0"

echo.
echo ============================================
echo CAP Json Creator
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
	echo [ERROR] Node.js is not installed or not in PATH.
	pause
	exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
	echo [ERROR] npm is not installed or not in PATH.
	pause
	exit /b 1
)

if not exist package.json (
	echo [ERROR] package.json not found in this folder.
	pause
	exit /b 1
)

echo [0/3] Stopping old Node.js processes...
powershell -NoProfile -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue" >nul 2>nul
timeout /t 1 /nobreak >nul

echo [1/4] Cleaning old build and node_modules...
if exist ".next" rmdir /s /q ".next"
if exist "node_modules" rmdir /s /q "node_modules"

echo [2/4] Installing dependencies...
call npm ci
if errorlevel 1 (
    echo [ERROR] npm ci failed.
    pause
    exit /b 1
)

echo [3/4] Creating fresh production build...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo [4/4] Starting app server in background...
start "CAP-Json-creator-server" /min cmd /c "cd /d ""%~dp0"" && npm run start"

echo [4/4] Waiting for server on http://localhost:3000 ...
set READY=0
for /l %%i in (1,1,30) do (
	powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://localhost:3000 -TimeoutSec 2; if ($r.StatusCode -ge 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
	if not errorlevel 1 (
		set READY=1
		goto :ready
	)
	timeout /t 1 /nobreak >nul
)

:ready
if "%READY%"=="1" (
	start "" "http://localhost:3000"
	echo.
	echo [OK] App is running at http://localhost:3000
	echo Browser opened automatically.
) else (
	echo.
	echo [WARN] Server did not respond in time.
	echo Try opening http://localhost:3000 manually in 10-20 seconds.
)

echo.
echo You can close this window.

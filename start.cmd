@echo off
REM Start CAP Leaflet Editor - Standalone

cd /d "%~dp0"

echo.
echo ============================================
echo CAP Leaflet Editor - Starting...
echo ============================================
echo.

cd .next\standalone
node server.js

@echo off
rem ============================================================
rem  Binance "primary-level pullback structure" monitor (8860)
rem  Standalone instance - appends logs to data\service.log
rem  ASCII-only on purpose: no codepage surprises.
rem ============================================================
cd /d "%~dp0"
if not exist "data" mkdir "data"
echo. >> "data\service.log"
echo ================ %date% %time% start ================ >> "data\service.log"
node server.js >> "data\service.log" 2>&1
echo [%date% %time%] exit code %errorlevel% >> "data\service.log"

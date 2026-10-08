@echo off
chcp 65001 >nul
title 币安主级别回踩结构盯盘（8860）
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node 22 或更高版本。
  pause
  exit /b 1
)

echo ============================================
echo   币安主级别回踩结构盯盘（独立实例）
echo   面板地址： http://127.0.0.1:8860
echo   级别组合： 2-10-1 / 3-15-2 / 5-30-3
echo   策略：主级别跌够N根不破前低
echo         → 中间级别收盘站上 MA7/EMA7
echo         → 次级别收盘上穿 MA7/EMA7 即报警
echo   关闭本窗口即停止服务
echo ============================================
echo.

start "" http://127.0.0.1:8860
node server.js

echo.
echo 服务已退出。
pause

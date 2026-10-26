@echo off
rem Moscow Coverage Analytics: start the local server and open http://localhost:8000
chcp 65001 >nul
cd /d "%~dp0"
where py >/dev/null 2>nul
if %errorlevel%==0 (
  py -3 serve.py %*
) else (
  python serve.py %*
)
if errorlevel 1 (
  echo.
  echo Python 3 not found or the server failed. Install Python 3.9+ from https://www.python.org/ and try again.
  pause
)

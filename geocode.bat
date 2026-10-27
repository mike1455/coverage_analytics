@echo off
rem Coverage analytics: coordinates for a file with addresses (asks for the file path)
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 tools\geocode_file.py %*
) else (
  python tools\geocode_file.py %*
)
if errorlevel 1 pause

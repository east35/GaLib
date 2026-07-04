@echo off
REM GaLib launcher (Windows) - double-click to start the web app.
cd /d "%~dp0"

where py >nul 2>&1
if %errorlevel%==0 (
  set "PY=py -3"
) else (
  where python >nul 2>&1
  if %errorlevel%==0 (
    set "PY=python"
  ) else (
    echo Python 3 is not installed. Install it from https://www.python.org/downloads/ and run this again.
    pause
    exit /b 1
  )
)

if not exist ".venv" (
  echo First-run setup: creating virtual environment...
  %PY% -m venv .venv
  call .venv\Scripts\pip.exe install --upgrade pip >nul
  call .venv\Scripts\pip.exe install -r requirements.txt
)

call .venv\Scripts\python.exe app.py
pause

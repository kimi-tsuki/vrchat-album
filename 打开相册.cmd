@echo off
setlocal
cd /d "%~dp0"
set "ALBUM_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist ".venv\Scripts\python.exe" set "ALBUM_PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%ALBUM_PYTHON%" set "ALBUM_PYTHON=python"
"%ALBUM_PYTHON%" app.py --open-browser
if errorlevel 1 pause

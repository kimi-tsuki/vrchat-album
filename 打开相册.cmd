@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
rem Python Install Manager must not download a runtime during this check.
set "PYTHON_MANAGER_AUTOMATIC_INSTALL=false"
if not exist "bootstrap.py" goto incomplete
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if not errorlevel 1 goto use_py
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if not errorlevel 1 goto use_python
set "ALBUM_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%ALBUM_PYTHON%" "%ALBUM_PYTHON%" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if exist "%ALBUM_PYTHON%" if not errorlevel 1 goto use_path
set "ALBUM_PYTHON=%~dp0.venv\Scripts\python.exe"
if exist "%ALBUM_PYTHON%" "%ALBUM_PYTHON%" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if exist "%ALBUM_PYTHON%" if not errorlevel 1 goto use_path
echo 未找到可运行的 Python 3.10 或更新版本。
echo 请从 https://www.python.org/downloads/ 安装 Python，然后重新双击此文件。
echo 本程序不会自动下载或安装 Python。
pause
exit /b 1

:use_py
py -3 "%~dp0bootstrap.py" %*
goto finished

:use_python
python "%~dp0bootstrap.py" %*
goto finished

:use_path
"%ALBUM_PYTHON%" "%~dp0bootstrap.py" %*
goto finished

:incomplete
echo 找不到 bootstrap.py。请完整解压相册后，在同一文件夹内重新双击此文件。
pause
exit /b 1

:finished
set "ALBUM_EXIT_CODE=%ERRORLEVEL%"
if not "%ALBUM_EXIT_CODE%"=="0" pause
exit /b %ALBUM_EXIT_CODE%

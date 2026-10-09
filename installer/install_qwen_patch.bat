@echo off
REM Installs the Qwen MCP always-on patch into C:\Program Files\Qwen (needs admin).
REM The stock bundle stays at app.asar.bak; run restore_qwen.bat to go back.
taskkill /IM Qwen.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
set "R=C:\Program Files\Qwen\resources"
if not exist "%R%\app.asar.bak" copy /Y "%R%\app.asar" "%R%\app.asar.bak" >nul
copy /Y "%~dp0app.asar" "%R%\app.asar" >nul || (echo FAILED to copy app.asar & exit /b 1)
if exist "%R%\mcp_terminal_server.js" erase "%R%\mcp_terminal_server.js"
echo SUCCESS> "%~dp0install_result.txt"
REM Qwen is not started from here on purpose: this script runs as admin, and Qwen (with its
REM Terminal tool) must run as the normal user.
echo Done. Start Qwen normally from the Start menu.

@echo off
REM Installs the Qwen MCP always-on patch into C:\Program Files\Qwen (needs admin).
REM The stock bundle stays at app.asar.bak; run restore_qwen.bat to go back.
set "R=C:\Program Files\Qwen\resources"

REM Never force-close Qwen silently: killing it mid tool-loop leaves the chat stuck on Qwen's
REM server ("The chat is in progress!"). Ask the user to close it themselves first.
:waitclose
tasklist /FI "IMAGENAME eq Qwen.exe" | find /I "Qwen.exe" >nul
if not errorlevel 1 (
  echo Qwen is running. Let any running task finish, close Qwen, then press a key.
  echo ^(Or press Ctrl+C to cancel.^)
  pause >nul
  goto waitclose
)

if not exist "%R%\app.asar.bak" copy /Y "%R%\app.asar" "%R%\app.asar.bak" >nul
copy /Y "%~dp0app.asar" "%R%\app.asar" >nul || (echo FAILED to copy app.asar & pause & exit /b 1)
if exist "%R%\mcp_terminal_server.js" erase "%R%\mcp_terminal_server.js"
echo SUCCESS> "%~dp0install_result.txt"
REM Qwen is not started from here on purpose: this script runs as admin, and Qwen (with its
REM Terminal tool) must run as the normal user.
echo Done. Start Qwen normally from the Start menu.
pause

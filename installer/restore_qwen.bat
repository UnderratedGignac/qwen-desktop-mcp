@echo off
REM Restores the stock Qwen bundle (needs admin).
taskkill /IM Qwen.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
copy /Y "C:\Program Files\Qwen\resources\app.asar.bak" "C:\Program Files\Qwen\resources\app.asar" >nul && echo Restored.
pause

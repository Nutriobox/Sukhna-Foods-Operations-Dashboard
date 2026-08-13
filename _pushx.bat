@echo off
cd /d "%~dp0"
del /f /q ".git\*.lock" 2>nul
del /f /q ".git\next-index-*.lock" 2>nul
echo Pushing to origin/main...
git push origin main
echo.
echo ---- DONE (exit code %errorlevel%) ----
pause

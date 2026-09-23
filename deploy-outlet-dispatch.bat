@echo off
cd /d "%~dp0"
del /f /q ".git\*.lock" 2>nul
echo Pushing the updated Outlet Dispatch Tool to origin/main...
echo (Vercel redeploys opsdashboard.sukhnafoods.com in ~1-2 min)
git push origin main
echo.
echo ---- DONE (exit code %errorlevel%) ----
pause

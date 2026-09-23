@echo off
cd /d "%~dp0"
del /f /q ".git\*.lock" 2>nul
echo Committing and pushing the new /api/live endpoint...
git add src/app/api/live/route.ts
git commit -m "Add /api/live endpoint for real-time single-voucher dispatch"
git push origin main
echo.
echo ================================================================
echo   DONE. Vercel redeploys opsdashboard.sukhnafoods.com in ~1-2 min.
echo   Only the new /api/live file is pushed; your other changes are untouched.
echo ================================================================
pause

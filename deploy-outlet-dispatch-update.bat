@echo off
cd /d "%~dp0"
del /f /q ".git\*.lock" 2>nul
echo Committing the updated Outlet Dispatch Tool...
git add public/outlet-dispatch/index.html
git commit -m "Update Outlet Dispatch Tool page (NutrioBox Dispatch 2)"
echo.
echo Pushing to origin/main — Vercel redeploys opsdashboard.sukhnafoods.com in ~1-2 min...
git push origin main
echo.
echo ================================================================
echo   Look for the push to succeed above. Then wait ~1-2 min and
echo   hard-refresh opsdashboard.sukhnafoods.com/outlet-dispatch/
echo   (Ctrl+F5) to see the new tool.
echo ================================================================
echo ---- DONE (exit code %errorlevel%) ----
pause

@echo off
cd /d "%~dp0"
del /f /q ".git\*.lock" 2>nul
echo Adding the NutrioBox past-invoices route...
git add src/app/api/nb-invoices/route.ts
git commit -m "Add /api/nb-invoices route for View past sales invoice (NB)"
echo Pushing to origin/main (Vercel redeploys in ~1-2 min)...
git push origin main
echo.
echo ---- DONE (exit code %errorlevel%) ----
pause

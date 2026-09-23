@echo off
cd /d "%~dp0"
del /f /q ".git\*.lock" 2>nul
echo Adding the NutrioBox Stock Outward route...
git add src/app/api/push-stock-outward/route.ts
git commit -m "Add /api/push-stock-outward route for NutrioBox dispatch"
echo Pushing to origin/main (Vercel will redeploy in ~1-2 min)...
git push origin main
echo.
echo ---- DONE (exit code %errorlevel%) ----
pause

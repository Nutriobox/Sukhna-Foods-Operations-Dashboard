@echo off
cd /d "%~dp0"
del /f /q ".git\*.lock" 2>nul
echo Adding the full-history invoice routes...
git add src/app/api/detail-fsi/route.ts src/app/api/nb-invoices/route.ts
git commit -m "Full-history past invoices: summary list + per-invoice line items on demand"
echo Pushing to origin/main (Vercel redeploys in ~1-2 min)...
git push origin main
echo.
echo ---- DONE (exit code %errorlevel%) ----
pause

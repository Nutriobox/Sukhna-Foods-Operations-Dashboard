@echo off
cd /d "%~dp0"
REM FSI commit is already made locally (9411ca1). This just clears any git
REM lock files and pushes it to GitHub, which auto-deploys on Vercel.
del /f /s /q ".git\*.lock" 2>nul
echo Pushing FSI commit to origin/main...
git push origin main
echo.
echo ---- DONE (exit code %errorlevel%) ----
echo If it says '9411ca1 ... main -> main' or 'Everything up-to-date after a push', it worked.
pause

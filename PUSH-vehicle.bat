@echo off
cd /d "C:\Users\hp\Documents\GitHub\Sukhna-Foods-Operations-Dashboard"
if exist ".git\index.lock" del /f ".git\index.lock"
echo Pushing dashboard update (Vercel will redeploy)...
git push origin main
if errorlevel 1 ( echo PUSH FAILED & pause & exit /b 1 )
git log --oneline -1
echo PUSHED > push-done.txt
echo Done. Vercel will rebuild in ~1-2 min.
pause

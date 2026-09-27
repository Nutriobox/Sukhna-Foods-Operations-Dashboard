@echo off
cd /d "%~dp0"
del /f /q ".git\*.lock" 2>nul
del /f /q ".git\index.lock" 2>nul
echo Committing the live PACT costing sync (routes, worker, scripts, dashboard)...
git add pact_costing_tables.sql ^
        src/app/api/sync-costing/route.ts ^
        "src/app/api/costing/[report]/route.ts" ^
        scripts/lib/costing-report.js ^
        scripts/sync-costing-pm.js scripts/sync-costing-bom.js scripts/sync-costing-pf.js scripts/sync-costing-si.js ^
        scripts/extract-costing-body.js ^
        pact-worker/worker.js ^
        public/costing/index.html ^
        record-costing.bat COSTING-LIVE-SYNC.md deploy-costing-live.bat
git commit -m "Add live (on-demand + scheduled) PACT sync for the Factory Costing Dashboard"
echo.
echo Pushing to origin/main -- Vercel redeploys opsdashboard.sukhnafoods.com in ~1-2 min...
git push origin main
echo.
echo ================================================================
echo   DONE. Next: run pact_costing_tables.sql in Supabase, deploy the
echo   updated worker.js + scripts to the AWS worker, then record each
echo   report (record-costing.bat pm / bom / pf / si). See
echo   COSTING-LIVE-SYNC.md for the full checklist.
echo ================================================================
echo ---- exit code %errorlevel% ----
pause

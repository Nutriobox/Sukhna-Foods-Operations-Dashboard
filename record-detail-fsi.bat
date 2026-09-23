@echo off
setlocal
cd /d "%~dp0pact-worker"
echo.
echo ============================================================
echo   PACT "Detail Factory Sales Invoices" REPORT Recorder
echo ------------------------------------------------------------
echo   1. Log in to PACT.
echo   2. Left menu: BI  ->  List of Reports.
echo   3. Open "Detail Factory Sales Invoices" (double-click).
echo   4. In the filter panel on the right:
echo        - Set Doc Date  FROM = TODAY  and  TO = TODAY.
echo        - Tick "Select All" for cost centers.
echo   5. Click OK so the report RUNS and rows show on screen.
echo   6. (If easy) click Export -> choose "Grid XLS" -> Export,
echo      so the Excel export step is captured too.
echo   7. Let the rows fully load, then CLOSE the browser window.
echo ============================================================
echo.
echo Preparing recorder (first run may take a minute)...
call npx playwright install chromium
call npx playwright codegen --ignore-https-errors --target=javascript --save-har="..\pact-detail-fsi.har" --save-har-glob="**" --output="..\pact-detail-fsi-steps.js" "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo Done. Saved in the dashboard folder:
echo    pact-detail-fsi.har         (network recording)
echo    pact-detail-fsi-steps.js    (recorded clicks)
echo.
echo Tell Claude "detail invoices recorded".
echo.
pause

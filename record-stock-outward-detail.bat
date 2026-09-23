@echo off
setlocal
cd /d "%~dp0pact-worker"
echo.
echo ============================================================
echo   PACT "Detail Stock Outward to Outlet" REPORT Recorder (NB)
echo ------------------------------------------------------------
echo   This is the NutrioBox version of "Detail Factory Sales
echo   Invoices" - the report of dispatches done via Stock
echo   Outward to Outlet.
echo.
echo   1. Log in to PACT.
echo   2. BI  ->  List of Reports.
echo   3. Search for the Stock Outward to Outlet detail report
echo      (e.g. "Detail Stock Outward to Outlet" or
echo       "Stock Outward to Outlet") and DOUBLE-CLICK to open.
echo   4. Set Doc Date FROM = today and TO = today, tick
echo      "Select All" cost centers, then click OK so it RUNS.
echo   5. (If easy) Export -> Grid XLS -> Export to capture it.
echo   6. Let rows load, then CLOSE the browser window.
echo ============================================================
echo.
echo Preparing recorder (first run may take a minute)...
call npx playwright install chromium
call npx playwright codegen --ignore-https-errors --target=javascript --save-har="..\pact-stock-outward-detail.har" --save-har-glob="**" --output="..\pact-stock-outward-detail-steps.js" "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo Done. Saved in the dashboard folder:
echo    pact-stock-outward-detail.har
echo    pact-stock-outward-detail-steps.js
echo.
echo Tell Claude "stock outward report recorded".
echo.
pause

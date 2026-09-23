@echo off
setlocal
cd /d "%~dp0pact-worker"
echo.
echo ============================================================
echo   PACT Pending OUTLET REQUISITION *REPORT* Recorder  (NB)
echo ------------------------------------------------------------
echo   This is the NutrioBox version of the B2B
echo   "Pending Sales Order Quantity" report you already use.
echo.
echo   1. Log in to PACT.
echo   2. Left menu: click BI  ->  List of Reports.
echo   3. Search for the OUTLET REQUISITION pending report
echo      (e.g. "Pending Outlet Material Requisition Quantity"
echo       or "Pending Material Requisition Quantity").
echo      DOUBLE-CLICK it to open.
echo   4. In the filter popup: check "Select All" for cost
echo      centers / outlets, pick the current period node
echo      (like FSOD-26-27 for B2B), then click OK so the
echo      report actually RUNS and shows rows.
echo   5. Let ALL rows load on screen.
echo   6. CLOSE the browser window to stop recording.
echo ============================================================
echo.
echo Preparing recorder (first run may take a minute)...
call npx playwright install chromium
call npx playwright codegen --ignore-https-errors --target=javascript --save-har="..\pact-outlet-pending.har" --save-har-glob="**" --output="..\pact-outlet-pending-steps.js" "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo Done. Saved in the dashboard folder:
echo    pact-outlet-pending.har         (network recording)
echo    pact-outlet-pending-steps.js    (recorded clicks)
echo.
echo Tell Claude "pending report recorded".
echo.
pause

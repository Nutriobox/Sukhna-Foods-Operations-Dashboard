@echo off
setlocal
cd /d "%~dp0pact-worker"
echo.
echo ============================================================
echo   PACT Pending Sales Orders Recorder
echo ------------------------------------------------------------
echo   A browser window will open at the PACT login page.
echo.
echo   1. Log in to PACT.
echo   2. Open the PENDING / OPEN SALES ORDERS screen (the list
echo      of sales orders that are not yet dispatched/invoiced).
echo   3. Let the list FULLY load on screen (all rows visible).
echo   4. If there is a filter for "Pending" / "Open" status,
echo      apply it so only un-dispatched orders show.
echo   5. Open ONE order so its line items load at least once
echo      (this lets Claude capture the item-level call too).
echo   6. CLOSE the browser window to stop recording.
echo ============================================================
echo.
echo Preparing recorder (first run may take a minute)...
call npx playwright install chromium
call npx playwright codegen --ignore-https-errors --target=javascript --save-har="..\pact-salesorders.har" --save-har-glob="**" --output="..\pact-salesorders-steps.js" "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo Done. These two files were saved in the dashboard folder:
echo    pact-salesorders.har         (network recording)
echo    pact-salesorders-steps.js    (recorded clicks)
echo.
echo You can tell Claude "done" now - it will read them from the folder.
echo.
pause

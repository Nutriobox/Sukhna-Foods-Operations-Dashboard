@echo off
setlocal
cd /d "%~dp0pact-worker"
echo.
echo ============================================================
echo   PACT Inventory Export Recorder
echo ------------------------------------------------------------
echo   A browser window will open at the PACT login page.
echo.
echo   1. Log in to PACT.
echo   2. Open the BatchWise Stock Analysis report.
echo   3. Set it the way you normally do (all warehouses, etc.)
echo   4. Click Export (Excel) and let it finish.
echo   5. CLOSE the browser window to stop recording.
echo ============================================================
echo.
echo Preparing recorder (first run may take a minute)...
call npx playwright install chromium
call npx playwright codegen --ignore-https-errors --target=javascript --save-har="..\pact-inventory.har" --save-har-glob="**" --output="..\pact-inventory-steps.js" "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo Done. These two files were saved in the dashboard folder:
echo    pact-inventory.har         (network recording)
echo    pact-inventory-steps.js    (recorded clicks)
echo.
echo You can tell Claude "done" now - it will read them from the folder.
echo.
pause

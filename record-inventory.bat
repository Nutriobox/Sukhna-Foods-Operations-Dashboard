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
if not exist "%USERPROFILE%\Downloads\pact-recordings" mkdir "%USERPROFILE%\Downloads\pact-recordings"
call npx playwright codegen --ignore-https-errors --target=javascript --save-har="%USERPROFILE%\Downloads\pact-recordings\pact-inventory.har" --save-har-glob="**" --output="%USERPROFILE%\Downloads\pact-recordings\pact-inventory-steps.js" "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo Done. These two files were saved in your Downloads\pact-recordings folder (NOT the code folder):
echo    pact-inventory.har         (network recording)
echo    pact-inventory-steps.js    (recorded clicks)
echo.
echo You can tell Claude "done" now - and where they are - never commit them.
echo.
pause

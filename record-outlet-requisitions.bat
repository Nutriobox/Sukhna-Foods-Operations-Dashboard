@echo off
setlocal
cd /d "%~dp0pact-worker"
echo.
echo ============================================================
echo   PACT Pending OUTLET MATERIAL REQUISITION Recorder  (NB)
echo ------------------------------------------------------------
echo   A browser window will open at the PACT login page.
echo.
echo   1. Log in to PACT.
echo   2. Open the PENDING / OUTLET MATERIAL REQUISITION QUANTITY
echo      report (the NutrioBox equivalent of the B2B "Pending
echo      Sales Order Quantity" report).
echo   3. Let the list FULLY load on screen (all rows visible).
echo   4. If there is a filter for the current period / "Pending",
echo      apply it so only un-dispatched requisitions show.
echo   5. CLOSE the browser window to stop recording.
echo ============================================================
echo.
echo Preparing recorder (first run may take a minute)...
call npx playwright install chromium
if not exist "%USERPROFILE%\Downloads\pact-recordings" mkdir "%USERPROFILE%\Downloads\pact-recordings"
call npx playwright codegen --ignore-https-errors --target=javascript --save-har="%USERPROFILE%\Downloads\pact-recordings\pact-outlet-req.har" --save-har-glob="**" --output="%USERPROFILE%\Downloads\pact-recordings\pact-outlet-req-steps.js" "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo Done. These two files were saved in your Downloads\pact-recordings folder (NOT the code folder):
echo    pact-outlet-req.har         (network recording)
echo    pact-outlet-req-steps.js    (recorded clicks)
echo.
echo Tell Claude "requisition recorded" - and where they are - never commit them.
echo.
pause

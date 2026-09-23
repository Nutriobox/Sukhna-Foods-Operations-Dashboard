@echo off
setlocal
cd /d "%~dp0pact-worker"
echo.
echo ============================================================
echo   PACT STOCK OUTWARD TO OUTLET Recorder  (NB dispatch)
echo ------------------------------------------------------------
echo   A browser window will open at the PACT login page.
echo.
echo   1. Log in to PACT.
echo   2. Open a NEW "Stock Outward to Outlet" document (the
echo      NutrioBox equivalent of the Factory Sales Invoice).
echo   3. Select the OUTLET / requisition the way you normally do
echo      so the document's lines load.
echo   4. Click into the SCAN box and scan (or type) ONE item
echo      barcode + Enter, so the scan field and the product grid
echo      are captured at least once.
echo   5. (Optional) Go as far as the POST button so the post
echo      step is captured too - but you do NOT have to actually
echo      post a real document.
echo   6. CLOSE the browser window to stop recording.
echo ============================================================
echo.
echo Preparing recorder (first run may take a minute)...
call npx playwright install chromium
call npx playwright codegen --ignore-https-errors --target=javascript --save-har="..\pact-stock-outward.har" --save-har-glob="**" --output="..\pact-stock-outward-steps.js" "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo Done. These two files were saved in the dashboard folder:
echo    pact-stock-outward.har         (network recording)
echo    pact-stock-outward-steps.js    (recorded clicks)
echo.
echo Tell Claude "outward recorded" - it will read them from the folder.
echo.
pause

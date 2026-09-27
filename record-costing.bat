@echo off
setlocal
cd /d "%~dp0"
set REP=%1
if "%REP%"=="" set REP=pm
echo.
echo ============================================================
echo   PACT Costing Report Recorder  --  report: %REP%
echo ------------------------------------------------------------
echo   Records ONE report so the live sync can replay it.
echo   Run it once for each: pm, bom, pf, si
echo       record-costing.bat pm     (Product Master)
echo       record-costing.bat bom    (Stage-wise BOM w/ Wastage)
echo       record-costing.bat pf     (Process Flow)
echo       record-costing.bat si     (Stock Inward)
echo.
echo   A browser opens at the PACT login page. Then:
echo     1. Log in to PACT.
echo     2. Open the report for "%REP%".
echo     3. Set it the way you normally do (dates, all warehouses...).
echo     4. Click Export (Excel) and let it finish.
echo     5. CLOSE the browser window to stop recording.
echo ============================================================
echo.
echo Preparing recorder (first run may take a minute)...
call npx playwright install chromium
call npx playwright codegen --ignore-https-errors --target=javascript --save-har="pact-costing-%REP%.har" --save-har-glob="**" --output="pact-costing-%REP%-steps.js" "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo Saved:  pact-costing-%REP%.har   (network recording)
echo Now extract the request body + column keys:
echo     node scripts\extract-costing-body.js pact-costing-%REP%.har
echo Paste BODY_B64 into scripts\sync-costing-%REP%.js  (and confirm COLMAP).
echo.
pause

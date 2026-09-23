@echo off
cd /d "%~dp0"
echo ==================================================================
echo   PACT Stock Inward  -  Playwright Recorder
echo ==================================================================
echo.
echo  Two windows will open: a Chromium browser and the
echo  "Playwright Inspector" (which shows the code as you click).
echo.
echo  DO THIS ONCE, start to finish:
echo    1) Log into PACT
echo    2) Open Flows -^> Stock Inward
echo    3) Do the WHOLE Stock Inward: pick vendor, bill no,
echo       fill Approve Qty, press Enter, Enter on Base Qty, create the
echo       batch (Manufactured date), Save ^& Add, Save, then POST.
echo    4) When the entry is Posted, CLOSE both windows.
echo.
echo  Everything you do is saved to:  pact-recording.js
echo ==================================================================
echo.
echo  Making sure the recorder browser is installed (first time only)...
call npx playwright install chromium
echo.
echo  Launching recorder...
call npx playwright codegen --target javascript --ignore-https-errors -o pact-recording.js "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login"
echo.
echo ==================================================================
echo   Recording saved as  pact-recording.js  in this folder.
echo   Tell Claude "done" and it will read the file.
echo ==================================================================
pause

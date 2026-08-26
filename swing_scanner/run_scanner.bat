@echo off
cd /d "%~dp0"
echo Running swing scanner against my_universe.csv...
echo (this takes several minutes -- fetching price history for every ticker)
echo.
"C:\Users\Vijji\AppData\Local\Programs\Python\Python312\python.exe" scanner.py --universe my_universe.csv
echo.
if %errorlevel% equ 0 (
    echo Done. Results pushed to the trade-management website -- click "Sync now" there to pull them in.
) else (
    echo Scan failed with exit code %errorlevel%. Scroll up to see the error.
)
pause

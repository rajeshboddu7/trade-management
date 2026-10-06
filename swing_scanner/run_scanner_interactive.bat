@echo off
rem Desktop-shortcut entry point: runs the scanner and keeps the window open so you can read the
rem result. run_scanner.bat itself stays pause-free since the Scheduled Task also runs it --
rem unattended, a pause there hangs forever waiting for a keypress nobody will send (this is
rem exactly what caused the Oct 6 task to get stuck "Running").
call "%~dp0run_scanner.bat"
pause

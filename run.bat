@echo off
rem Vomix Studio (dev copy): opens the program in its own window, no console. Closing the window stops the server.
cd /d "%~dp0"
start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0launcher.py"

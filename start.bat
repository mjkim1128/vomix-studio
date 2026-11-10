@echo off
rem 음MAD 툴 실행: 서버를 켜고 브라우저를 엽니다. 끄려면 이 창을 닫으세요.
cd /d "%~dp0app"
set PYTHONPATH=%~dp0
start "" http://127.0.0.1:8765
"%~dp0.venv\Scripts\python.exe" -m uvicorn server:app --port 8765

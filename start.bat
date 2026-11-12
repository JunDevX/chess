@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\ws" (
  echo Устанавливаю зависимости...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo Не удалось установить зависимости. Нужен Node.js и доступ в интернет.
    pause
    exit /b 1
  )
)
echo.
echo Откройте http://localhost:3000 — ссылку для друга сервер покажет ниже.
echo.
node server.js
pause

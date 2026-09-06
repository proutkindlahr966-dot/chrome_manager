@echo off
REM Launcher co log — chay tu scripts\, cd ve project root
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Chua cai Node.js. Hay cai tu https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Dang cai dat dependencies lan dau...
  call npm install
  if errorlevel 1 (
    echo Cai dat that bai.
    pause
    exit /b 1
  )
)

echo Dang khoi dong Chrome Manager...
call npm run dev
if errorlevel 1 pause

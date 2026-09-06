@echo off
REM Tao shortcut Chrome Manager.lnk o project root (double-click mo app)
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = '%CD%';" ^
  "$vbs = Join-Path $dir 'scripts\start-silent.vbs';" ^
  "$wsh = New-Object -ComObject WScript.Shell;" ^
  "$lnk = Join-Path $dir 'Chrome Manager.lnk';" ^
  "$s = $wsh.CreateShortcut($lnk);" ^
  "$s.TargetPath = 'wscript.exe';" ^
  "$s.Arguments = '\"' + $vbs + '\"';" ^
  "$s.WorkingDirectory = $dir;" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'Chrome Manager';" ^
  "$exe = Join-Path $dir 'node_modules\electron\dist\electron.exe';" ^
  "if (Test-Path $exe) { $s.IconLocation = \"$exe,0\" };" ^
  "$s.Save();" ^
  "Write-Host \"Da tao shortcut: $lnk\""
if errorlevel 1 (
  echo Tao shortcut that bai.
  pause
  exit /b 1
)
echo.
echo Shortcut "Chrome Manager.lnk" da co trong thu muc project.
echo Double-click de mo app (khong hien cua so CMD).
pause

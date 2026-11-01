@echo off
rem Fieldbook starten. Normalerweise ueber die Verknuepfung im Hauptordner.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 (
  echo.
  echo Es ist ein Fehler aufgetreten. Taste druecken zum Schliessen.
  pause >nul
)

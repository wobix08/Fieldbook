@echo off
rem Fieldbook starten. Normalerweise ueber die Verknuepfung im Hauptordner.
rem Alles nach dem PowerShell-Aufruf steht in derselben Zeile: Ein Update kann diese Datei waehrend
rem des Laufs ersetzen, cmd liest danach keine weitere Zeile mehr.
pushd "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" & (if errorlevel 1 (echo.&echo Es ist ein Fehler aufgetreten. Taste druecken zum Schliessen.&pause >nul)) & popd & exit /b

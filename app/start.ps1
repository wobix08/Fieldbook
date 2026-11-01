# Fieldbook Starter
# Kompiliert den kleinen Server (Server.cs) und startet ihn. Keine Installation nötig.
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Fieldbook'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$app  = $PSScriptRoot
$root = Split-Path -Parent $app
$port = 8090

# Das Fenster startet minimiert (Fieldbook.exe). Bei Fehlern wieder zeigen, damit man die Meldung sieht.
function Fenster-Zeigen {
    try {
        Add-Type -Name Fenster -Namespace Fieldbook -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'
        [Fieldbook.Fenster]::ShowWindow([Fieldbook.Fenster]::GetConsoleWindow(), 9) | Out-Null
    } catch {}
}

Clear-Host
Write-Host ''
Write-Host '  Fieldbook' -ForegroundColor Green -NoNewline
Write-Host '  ·  Wissen, wo kein Netz ist' -ForegroundColor DarkGray
Write-Host '  ────────────────────────────────────' -ForegroundColor DarkGray
Write-Host ''

# Läuft das Programm schon? Dann nur den Browser öffnen.
try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$port/api/status"
    if ($r.StatusCode -eq 200) {
        Write-Host '  Fieldbook läuft bereits. Der Browser wird geöffnet.'
        # Fieldbook entscheidet selbst: offenen Tab nach vorne holen oder einen neuen öffnen
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://localhost:$port/api/zeigen" | Out-Null }
        catch { Start-Process "http://localhost:$port/" }
        Start-Sleep -Seconds 2
        exit 0
    }
} catch {}

# Bereitgelegtes Fieldbook-Update einspielen, bevor der Programmteil geladen wird.
# Vorher wird der alte Programmteil gesichert; klappt etwas nicht, wird er wiederhergestellt.
$bereit    = Join-Path $root 'daten\cache\update\bereit'
$sicherung = Join-Path $root 'daten\cache\update\sicherung'
$aktualisiert = $false
function Spiegeln($von, $nach) {
    # Start.bat läuft gerade selbst und wird nur ersetzt, wenn sie sich geändert hat
    robocopy $von $nach /MIR /XF Start.bat /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Kopieren fehlgeschlagen (robocopy $LASTEXITCODE)" }
    $batNeu = Join-Path $von 'Start.bat'; $batAlt = Join-Path $nach 'Start.bat'
    if ((Test-Path $batNeu) -and (-not (Test-Path $batAlt) -or (Get-FileHash $batNeu).Hash -ne (Get-FileHash $batAlt).Hash)) { Copy-Item -Force $batNeu $batAlt }
}
if ((Test-Path (Join-Path $bereit 'app\Server.cs')) -and -not (Test-Path (Join-Path $root '.git'))) {
    $neu = Get-Content (Join-Path $bereit 'version.txt') -ErrorAction SilentlyContinue | Select-Object -First 1
    Write-Host "  Fieldbook wird auf Version $neu aktualisiert ..." -ForegroundColor Cyan
    try {
        if (Test-Path $sicherung) { Remove-Item -Recurse -Force $sicherung }
        New-Item -ItemType Directory -Force $sicherung | Out-Null
        Copy-Item -Recurse -Force $app (Join-Path $sicherung 'app')
        Spiegeln (Join-Path $bereit 'app') $app
        # Dateien im Hauptordner (Startdatei, Anleitung, Lizenzen); der Ordner "daten" bleibt unangetastet
        Get-ChildItem $bereit -File | Where-Object { $_.Name -ne 'version.txt' } | ForEach-Object { Copy-Item -Force $_.FullName (Join-Path $root $_.Name) }
        # Seit 0.5.1 heißen Anleitung und Drittanbieter-Liste englisch; alte Namen entfernen
        foreach ($alt in @('Anleitung.txt', 'Drittanbieter.txt')) {
            if (Test-Path (Join-Path $root 'GUIDE.txt')) { Remove-Item -Force (Join-Path $root $alt) -ErrorAction SilentlyContinue }
        }
        Remove-Item -Recurse -Force $bereit
        $aktualisiert = $true
        Write-Host "  Aktualisiert auf Version $neu." -ForegroundColor Green
    } catch {
        Fenster-Zeigen
        Write-Host "  Update fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host '  Die bisherige Version wird wiederhergestellt.' -ForegroundColor Yellow
        if (Test-Path (Join-Path $sicherung 'app\Server.cs')) { Spiegeln (Join-Path $sicherung 'app') $app }
        Remove-Item -Recurse -Force $bereit -ErrorAction SilentlyContinue
    }
}

Write-Host '  Wird gestartet ...'
$refs = @('System.Web.Extensions', 'System.Management', 'System.Windows.Forms',
          'System.IO.Compression', 'System.IO.Compression.FileSystem', 'System.Net', 'System.Core')
try {
    Add-Type -Path (Join-Path $app 'Server.cs') -ReferencedAssemblies $refs
} catch {
    $fehler = $_.Exception.Message
    if ($aktualisiert -and (Test-Path (Join-Path $sicherung 'app\Server.cs'))) {
        # Neue Version lässt sich nicht laden: zurück zur alten
        Write-Host '  Die neue Version konnte nicht geladen werden. Die bisherige Version wird wiederhergestellt.' -ForegroundColor Yellow
        try {
            Spiegeln (Join-Path $sicherung 'app') $app
            Add-Type -Path (Join-Path $app 'Server.cs') -ReferencedAssemblies $refs
            $fehler = $null
        } catch { $fehler = $_.Exception.Message }
    }
    if ($fehler) {
        Fenster-Zeigen
        Write-Host ''
        Write-Host '  Der Programmteil konnte nicht vorbereitet werden:' -ForegroundColor Red
        Write-Host "  $fehler" -ForegroundColor Red
        exit 1
    }
}

Write-Host '  Fieldbook läuft im Browser: ' -NoNewline
Write-Host "http://localhost:$port" -ForegroundColor Green
Write-Host '  Dieses Fenster kann minimiert bleiben. Beenden: Aus-Knopf oben rechts' -ForegroundColor Gray
Write-Host '  in Fieldbook oder dieses Fenster schließen.' -ForegroundColor Gray
Write-Host ''
# Meldungen des Servers dezent in Grau
try { [Console]::ForegroundColor = 'DarkGray' } catch {}
try {
    [OfflineWissen.App]::Start($root, $port)
} catch {
    Fenster-Zeigen
    try { [Console]::ResetColor() } catch {}
    Write-Host ''
    Write-Host '  Fehler beim Start:' -ForegroundColor Red
    Write-Host "  $($_.Exception.InnerException.Message) $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

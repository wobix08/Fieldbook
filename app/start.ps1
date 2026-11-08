# Fieldbook Starter
# Kompiliert den kleinen Server (Server.cs) und startet ihn. Keine Installation nötig.
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Fieldbook'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$app  = $PSScriptRoot
$root = Split-Path -Parent $app
$port = 8090

# Startfortschritt für das Startfenster (Fieldbook.exe): eine Zeile in daten\cache\startstatus.txt, Fehler egal
function Status-Schreiben($text) {
    try {
        $ordner = Join-Path $root 'daten\cache'
        New-Item -ItemType Directory -Force $ordner | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $ordner 'startstatus.txt'), $text, (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}

# Reste vom letzten Update (laufende Startdatei wurde umbenannt) still löschen
Remove-Item -Force (Join-Path $root 'Fieldbook.exe.alt') -ErrorAction SilentlyContinue

# Das Fenster startet minimiert (Fieldbook.exe). Bei Fehlern wieder zeigen, damit man die Meldung sieht.
function Fenster-Zeigen {
    Status-Schreiben 'fehler'
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

# Antwortet ein laufendes Fieldbook?
function Fieldbook-Antwortet {
    # Erst nachsehen, ob überhaupt etwas auf dem Anschluss lauscht: Eine abgelehnte Verbindung zu
    # localhost probiert Windows mehrmals und braucht dafür etwa 2 Sekunden
    try {
        $lauscht = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $port }
        if (-not $lauscht) { return $false }
    } catch {}
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$port/api/status"
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# Nur den Browser öffnen und dieses Fenster beenden.
function Nur-Browser-Oeffnen {
    Status-Schreiben 'fertig'
    if (-not $env:OW_KEIN_BROWSER) {
        # Fieldbook entscheidet selbst: offenen Tab nach vorne holen oder einen neuen öffnen
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://localhost:$port/api/zeigen" | Out-Null }
        catch { try { Start-Process "http://localhost:$port/" } catch {} }
    }
    Start-Sleep -Seconds 2
    exit 0
}

# Nur ein Start gleichzeitig: Wer zuerst kommt, hält die Sperre bis Fieldbook beendet ist.
# Der Anschluss 8090 ist fest, deshalb kann ohnehin nur ein Fieldbook laufen (egal in welchem Ordner).
$sperre = New-Object System.Threading.Mutex($false, 'Local\Fieldbook')
$sperreErhalten = $false
try { $sperreErhalten = $sperre.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $sperreErhalten = $true }   # Vorheriger Start ist abgestürzt: Sperre gehört jetzt uns
if (-not $sperreErhalten) {
    # Ein anderer Start ist gerade dabei, oder ein altes Fieldbook beendet sich gerade (Neustart nach Update).
    # Warten (höchstens eine Minute): Antwortet Fieldbook, nur den Browser öffnen.
    # Wird die Sperre frei, weil sich das alte beendet hat, normal weiterstarten.
    Write-Host '  Fieldbook wird gerade gestartet. Bitte einen Moment warten ...'
    $bereitAb = (Get-Date).AddSeconds(60)
    while (-not $sperreErhalten -and (Get-Date) -lt $bereitAb) {
        if (Fieldbook-Antwortet) {
            Write-Host '  Der Browser wird geöffnet.'
            Nur-Browser-Oeffnen
        }
        try { $sperreErhalten = $sperre.WaitOne(1000) }
        catch [System.Threading.AbandonedMutexException] { $sperreErhalten = $true }
    }
    if (-not $sperreErhalten) {
        Write-Host '  Der Browser wird geöffnet.'
        Nur-Browser-Oeffnen
    }
}

# Läuft das Programm schon (z. B. von einem älteren Start ohne Sperre)? Dann nur den Browser öffnen.
if (Fieldbook-Antwortet) {
    Write-Host '  Fieldbook läuft bereits. Der Browser wird geöffnet.'
    Nur-Browser-Oeffnen
}

# Bereitgelegtes Fieldbook-Update einspielen, bevor der Programmteil geladen wird.
# Vorher wird der alte Programmteil gesichert; klappt etwas nicht, wird er wiederhergestellt.
$bereit    = Join-Path $root 'daten\cache\update\bereit'
$sicherung = Join-Path $root 'daten\cache\update\sicherung'
$sicherungFertig = Join-Path $sicherung 'fertig'
$bereitGestartet = Join-Path $bereit 'gestartet'
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
    Status-Schreiben 'Fieldbook wird aktualisiert …'
    try {
        # Marken gegen abgebrochene Updates (Akku leer, Standby):
        #   sicherung\fertig  = die Sicherung ist vollständig
        #   bereit\gestartet  = das Einspielen hat begonnen, der Programmordner kann halb aktualisiert sein
        # Ist beides da, wurde ein Update unterbrochen. Dann nicht neu sichern (der Programmordner ist ja schon
        # halb neu), sondern das Einspielen einfach noch einmal durchführen.
        if (-not ((Test-Path $sicherungFertig) -and (Test-Path $bereitGestartet))) {
            if (Test-Path $sicherung) {
                Remove-Item -Force $sicherungFertig -ErrorAction SilentlyContinue
                Remove-Item -Recurse -Force $sicherung
            }
            New-Item -ItemType Directory -Force $sicherung | Out-Null
            Copy-Item -Recurse -Force $app (Join-Path $sicherung 'app')
            [System.IO.File]::WriteAllText($sicherungFertig, 'fertig')
        }
        [System.IO.File]::WriteAllText($bereitGestartet, 'gestartet')
        Spiegeln (Join-Path $bereit 'app') $app
        # Dateien im Hauptordner (Startdatei, Anleitung, Lizenzen); der Ordner "daten" bleibt unangetastet
        # Eine laufende Datei (Fieldbook.exe, das Startfenster) ist gesperrt: dann die alte in <Name>.alt umbenennen und neu kopieren
        Get-ChildItem $bereit -File | Where-Object { $_.Name -ne 'version.txt' -and $_.Name -ne 'gestartet' } | ForEach-Object {
            $ziel = Join-Path $root $_.Name
            try { Copy-Item -Force $_.FullName $ziel }
            catch {
                $alt = "$ziel.alt"
                Remove-Item -Force $alt -ErrorAction SilentlyContinue
                Move-Item -Force $ziel $alt
                Copy-Item -Force $_.FullName $ziel
            }
        }
        # Seit 0.5.1 heißen die Textdateien englisch; alte Namen aufräumen
        if (Test-Path (Join-Path $root 'GUIDE.txt')) {
            foreach ($alt in @('Anleitung.txt', 'Drittanbieter.txt')) { Remove-Item -Force (Join-Path $root $alt) -ErrorAction SilentlyContinue }
        }
        $liesmich = Join-Path $root 'daten\liesmich.txt'
        if (Test-Path $liesmich) {
            try {
                Set-Content -Path (Join-Path $root 'daten\README.txt') -Encoding UTF8 -Value 'Hier speichert Fieldbook Bibliotheken, KI-Modelle und Karten. Bitte nicht von Hand ändern.'
                Remove-Item -Force $liesmich
            } catch { }
        }
        Remove-Item -Recurse -Force $bereit
        $aktualisiert = $true
        Write-Host "  Aktualisiert auf Version $neu." -ForegroundColor Green
    } catch {
        Fenster-Zeigen
        Write-Host "  Update fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host '  Die bisherige Version wird wiederhergestellt.' -ForegroundColor Yellow
        # Nur aus einer vollständigen Sicherung zurückspielen
        if ((Test-Path $sicherungFertig) -and (Test-Path (Join-Path $sicherung 'app\Server.cs'))) { Spiegeln (Join-Path $sicherung 'app') $app }
        Remove-Item -Recurse -Force $bereit -ErrorAction SilentlyContinue
    }
}

Write-Host '  Wird gestartet ...'
Status-Schreiben 'Programm wird vorbereitet …'
$refs = @('System.Web.Extensions', 'System.Management', 'System.Windows.Forms',
          'System.IO.Compression', 'System.IO.Compression.FileSystem', 'System.Net', 'System.Core')

# Programmteil laden. Die übersetzte DLL wird aufgehoben (daten\cache\programm), damit Server.cs
# nicht bei jedem Start neu übersetzt werden muss. Klappt der Zwischenspeicher nicht, wird wie früher direkt übersetzt.
function Programm-Laden {
    $cs = Join-Path $app 'Server.cs'
    try {
        $ordner = Join-Path $root 'daten\cache\programm'
        # Kennung aus Quelltext und Laufzeitumgebung: ändert sich eines davon, wird neu übersetzt
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $csHash = [System.BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($cs)))
        $umgebung = "$csHash|$($PSVersionTable.PSVersion)|$($PSVersionTable.CLRVersion)|$([System.Environment]::Version)"
        $kennung = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($umgebung))) -replace '-', '').Substring(0, 16).ToLower()
        $dll = Join-Path $ordner "Server-$kennung.dll"
        if (-not (Test-Path $dll)) {
            New-Item -ItemType Directory -Force $ordner | Out-Null
            # Erst in eine Temp-Datei übersetzen, damit ein Abbruch keine halbe DLL hinterlässt
            $tmp = Join-Path $ordner ("Server-neu-" + [Guid]::NewGuid().ToString('N') + '.tmp')
            try {
                Add-Type -Path $cs -ReferencedAssemblies $refs -OutputAssembly $tmp -OutputType Library
                Move-Item -Force $tmp $dll
            } finally { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
        }
        # Falls Add-Type die Typen nicht schon geladen hat: die DLL laden
        if (-not ('OfflineWissen.App' -as [type])) { Add-Type -Path $dll }
        if ('OfflineWissen.App' -as [type]) {
            # Alte Zwischenspeicher-Dateien aufräumen (gesperrte bleiben einfach liegen)
            Get-ChildItem $ordner -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "Server-$kennung.dll" } |
                ForEach-Object { Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue }
            return
        }
    } catch {}
    # Zwischenspeicher nicht nutzbar: direkt übersetzen (Fehler gehen an den Aufrufer)
    if (-not ('OfflineWissen.App' -as [type])) { Add-Type -Path $cs -ReferencedAssemblies $refs }
}

try {
    Programm-Laden
} catch {
    $fehler = $_.Exception.Message
    if ($aktualisiert -and (Test-Path $sicherungFertig) -and (Test-Path (Join-Path $sicherung 'app\Server.cs'))) {
        # Neue Version lässt sich nicht laden: zurück zur alten
        Write-Host '  Die neue Version konnte nicht geladen werden. Die bisherige Version wird wiederhergestellt.' -ForegroundColor Yellow
        try {
            Spiegeln (Join-Path $sicherung 'app') $app
            Programm-Laden
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
    # Ist der Anschluss von einem fremden Programm belegt? Der Fehler kann verschachtelt ankommen.
    $portBelegt = $false
    $e = $_.Exception
    while ($e) {
        if ($e -is [System.Net.HttpListenerException] -and (@(32, 183) -contains $e.ErrorCode)) { $portBelegt = $true }
        $e = $e.InnerException
    }
    if ($portBelegt) {
        Write-Host "  Fieldbook konnte nicht starten, weil ein anderes Programm den Anschluss $port belegt." -ForegroundColor Red
        Write-Host '  Bitte das andere Programm beenden oder den Laptop neu starten.' -ForegroundColor Yellow
    } else {
        Write-Host '  Fehler beim Start:' -ForegroundColor Red
        Write-Host "  $($_.Exception.InnerException.Message) $($_.Exception.Message)" -ForegroundColor Red
    }
    exit 1
}

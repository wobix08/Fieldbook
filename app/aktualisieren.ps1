# Fieldbook: automatische Aktualisierung (wird von der Windows-Aufgabenplanung gestartet)
#   -Modus pruefen  : einmal pro Woche kurz nach neuen Daten suchen (im Modus "fragen" mit Pop-up),
#                     im Sofort-Modus danach direkt mit niedriger Priorität herunterladen
#   -Modus laden    : freigegebene, unterbrochene Downloads fortsetzen
param([string]$Modus = 'pruefen')
$ErrorActionPreference = 'Stop'
$app  = $PSScriptRoot
$root = Split-Path -Parent $app

# Nichts zu tun? Dann sofort beenden, ohne etwas zu laden oder zu kompilieren.
if ($Modus -eq 'laden' -and -not (Test-Path -LiteralPath (Join-Path $root 'daten\aktualisierung-bereit'))) { exit 0 }

# Fehler in daten\logs\aktualisierung.log protokollieren (Fehler beim Protokollieren sind egal)
function Protokoll($text) {
    try {
        $logOrdner = Join-Path $root 'daten\logs'
        New-Item -ItemType Directory -Force -Path $logOrdner | Out-Null
        Add-Content -LiteralPath (Join-Path $logOrdner 'aktualisierung.log') -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $text) -Encoding UTF8
    } catch {}
}

# Eingeschränktes PowerShell (Constrained Language): Server.cs lässt sich nicht übersetzen
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Protokoll 'Aktualisierung abgebrochen: PowerShell ist eingeschränkt (Constrained Language).'
    exit 1
}

# Getaktete Verbindung (z. B. Handy-Hotspot)? Wird an das Programm weitergegeben:
# automatisch wird dann nicht geladen, beim Nachfragen warnt das Pop-up.
# Im Zweifel (Abfrage scheitert) gilt die Verbindung als getaktet.
$env:OW_GETAKTET = '1'
try {
    $null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
    $profil = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
    if ($null -eq $profil) { exit 0 }
    $kosten = $profil.GetConnectionCost()
    $art = $kosten.NetworkCostType.ToString()
    $grenze = $false
    try { $grenze = $kosten.ApproachingDataLimit -or $kosten.OverDataLimit } catch {}
    if ($art -in @('Unrestricted', 'Unknown') -and -not $kosten.Roaming -and -not $grenze) { $env:OW_GETAKTET = '0' }
} catch {}

# Niedrige Priorität, damit der Computer nicht gebremst wird
try { (Get-Process -Id $PID).PriorityClass = 'Idle' } catch {}

$refs = @('System.Web.Extensions', 'System.Management', 'System.Windows.Forms',
          'System.IO.Compression', 'System.IO.Compression.FileSystem', 'System.Net', 'System.Core')
try {
    Add-Type -LiteralPath (Join-Path $app 'Server.cs') -ReferencedAssemblies $refs
} catch {
    Protokoll "Programmteil (Server.cs) konnte nicht übersetzt werden: $($_.Exception.Message)"
    exit 1
}
exit [OfflineWissen.App]::Aktualisierung($root, $Modus)

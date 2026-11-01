# Fieldbook: automatische Aktualisierung (wird von der Windows-Aufgabenplanung gestartet)
#   -Modus pruefen  : einmal pro Woche kurz nach neuen Daten suchen (im Modus "fragen" mit Pop-up),
#                     im Sofort-Modus danach direkt mit niedriger Priorität herunterladen
#   -Modus laden    : freigegebene, unterbrochene Downloads fortsetzen
param([string]$Modus = 'pruefen')
$ErrorActionPreference = 'Stop'
$app  = $PSScriptRoot
$root = Split-Path -Parent $app

# Nichts zu tun? Dann sofort beenden, ohne etwas zu laden oder zu kompilieren.
if ($Modus -eq 'laden' -and -not (Test-Path (Join-Path $root 'daten\aktualisierung-bereit'))) { exit 0 }

# Getaktete Verbindung (z. B. Handy-Hotspot)? Wird an das Programm weitergegeben:
# automatisch wird dann nicht geladen, beim Nachfragen warnt das Pop-up.
$env:OW_GETAKTET = '0'
try {
    $null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
    $profil = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
    if ($null -eq $profil) { exit 0 }
    $kosten = $profil.GetConnectionCost()
    if ($kosten.NetworkCostType.ToString() -in @('Fixed', 'Variable') -or $kosten.Roaming) { $env:OW_GETAKTET = '1' }
} catch {}

# Niedrige Priorität, damit der Computer nicht gebremst wird
try { (Get-Process -Id $PID).PriorityClass = 'Idle' } catch {}

$refs = @('System.Web.Extensions', 'System.Management', 'System.Windows.Forms',
          'System.IO.Compression', 'System.IO.Compression.FileSystem', 'System.Net', 'System.Core')
Add-Type -Path (Join-Path $app 'Server.cs') -ReferencedAssemblies $refs
exit [OfflineWissen.App]::Aktualisierung($root, $Modus)

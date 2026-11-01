# Baut das Release-Paket dist\Fieldbook-<Version>.zip
# Inhalt: Startdatei, app\, Anleitung (GUIDE.txt), Lizenzen (LICENSE.txt, THIRD-PARTY.txt). Keine Downloads (daten\, programme\).
param([string]$Version = '0.5.1.1')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$ordner = Join-Path $dist 'Fieldbook'

if (Test-Path $ordner) { Remove-Item -Recurse -Force $ordner }
New-Item -ItemType Directory -Force $ordner | Out-Null

& (Join-Path $PSScriptRoot 'starter-bauen.ps1') -Ziel $ordner
Copy-Item -Recurse (Join-Path $root 'app') (Join-Path $ordner 'app')
Copy-Item (Join-Path $root 'GUIDE.md') (Join-Path $ordner 'GUIDE.txt')
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $ordner 'LICENSE.txt')
Copy-Item (Join-Path $root 'THIRD-PARTY.md') (Join-Path $ordner 'THIRD-PARTY.txt')

# Leere Ordner anlegen, damit klar ist, wohin die Daten kommen
New-Item -ItemType Directory -Force (Join-Path $ordner 'daten') | Out-Null
Set-Content -Path (Join-Path $ordner 'daten\README.txt') -Encoding UTF8 -Value 'Hier speichert Fieldbook Bibliotheken, KI-Modelle und Karten. Bitte nicht von Hand ändern.'

$zip = Join-Path $dist "Fieldbook-$Version.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
# Selbst packen statt Compress-Archive: Pfade mit "/" (ZIP-Standard), damit jeder Entpacker sie versteht
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archiv = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
    $basis = (Split-Path -Parent $ordner).TrimEnd('\') + '\'
    foreach ($f in Get-ChildItem -Path $ordner -Recurse -File) {
        $name = $f.FullName.Substring($basis.Length).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archiv, $f.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $archiv.Dispose() }

# Prüfsumme für die Release-Seite (Nutzer können damit die Echtheit prüfen)
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path "$zip.sha256" -Encoding ASCII -Value "$hash  $(Split-Path -Leaf $zip)"
Write-Host "SHA256: $hash"
Write-Host "Release erstellt: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
Write-Host "Nicht vergessen: Download-Link im Schnellstart der README auf die neue Version setzen."

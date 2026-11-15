# Baut die Wortlisten in app/config/woerter/ für die Spracherkennung im Sprechmodus.
# Quelle: FrequencyWords von Hermit Dave (Untertitel von OpenSubtitles 2018), Inhalt CC BY-SA 4.0,
# https://github.com/hermitdave/FrequencyWords
# Je Sprache die 5000 häufigsten Wörter mit ihrer Anzahl; erste Zeile "# gesamt <N>" = Summe der 50k-Liste.
# Aufruf: tools\woerter-bauen.ps1 (lädt die Listen aus dem Netz)
$ErrorActionPreference = 'Stop'
$wurzel = Split-Path -Parent $PSScriptRoot
$ziel = Join-Path $wurzel 'app\config\woerter'
New-Item -ItemType Directory -Force $ziel | Out-Null
$konf = Get-Content (Join-Path $wurzel 'app\config\spracheingabe.json') -Raw -Encoding UTF8 | ConvertFrom-Json
# Fieldbook-Code → Code bei FrequencyWords (wo abweichend)
$codes = @{ nb = 'no' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($l in $konf.parakeet) {
  $fw = if ($codes.ContainsKey($l)) { $codes[$l] } else { $l }
  $url = "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/$fw/${fw}_50k.txt"
  try { $text = (Invoke-WebRequest -UseBasicParsing $url).Content } catch { Write-Host "$l : keine Liste ($($_.Exception.Message))"; continue }
  if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
  $zeilen = $text -split "`n" | Where-Object { $_ -match '^\S+ \d+' }
  $gesamt = 0L
  foreach ($z in $zeilen) { $gesamt += [long]($z.Split(' ')[1]) }
  $aus = @("# gesamt $gesamt") + ($zeilen | Select-Object -First 5000 | ForEach-Object { $_.Trim() })
  [IO.File]::WriteAllLines((Join-Path $ziel "$l.txt"), $aus, $utf8)
  Write-Host "$l : $($zeilen.Count) Wörter, gesamt $gesamt"
}

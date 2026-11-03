# Baut app/web/symbole.svg aus der Lucide-Symbolsammlung (ISC-Lizenz, https://lucide.dev).
# Aufruf: tools\symbole-bauen.ps1 -Lucide <Pfad zu lucide.js (UMD-Build)>
# Neue Symbole: Namen unten in $namen ergänzen und das Skript erneut ausführen.
param([Parameter(Mandatory = $true)][string]$Lucide)

$namen = @(
  # Kopfzeile und Startseite
  'message-circle', 'library', 'cooking-pot', 'map', 'briefcase-medical', 'sun', 'moon', 'settings', 'power', 'zap',
  'download', 'plug', 'battery', 'battery-low', 'flame',
  # Bibliothek und Lesen
  'book-open', 'heart-pulse', 'wrench', 'tent', 'sprout', 'graduation-cap', 'puzzle', 'book-heart', 'package',
  'file-text', 'house', 'shuffle', 'languages',
  # Fragen
  'plus', 'history', 'x',
  # Karten und Routen
  'compass', 'hospital', 'pill', 'droplet', 'shield', 'shopping-cart', 'fuel', 'footprints', 'bike', 'car',
  # Erste Hilfe
  'phone', 'phone-off', 'siren', 'baby', 'triangle-alert', 'heart', 'wind', 'activity', 'brain', 'bug', 'circle-alert',
  'candy', 'bone', 'skull', 'thermometer', 'bed', 'grape', 'axe', 'speech', 'soup', 'zap-off', 'drama',
  # Kochen
  'archive', 'wheat', 'refrigerator', 'calendar', 'search',
  # Vorsorge
  'shield-check', 'box', 'backpack', 'printer', 'calculator', 'warehouse',
  # Inhalte und Einstellungen
  'folder', 'usb', 'refresh-cw', 'rotate-ccw',
  # Übersetzen
  'arrow-left-right', 'maximize-2', 'send', 'mic', 'square', 'volume-2'
)

$js = [IO.File]::ReadAllText($Lucide)
$sb = New-Object Text.StringBuilder
[void]$sb.AppendLine('<svg xmlns="http://www.w3.org/2000/svg">')
[void]$sb.AppendLine('<!-- Symbole aus Lucide (https://lucide.dev), ISC-Lizenz: Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022. Erzeugt mit tools/symbole-bauen.ps1. -->')
foreach ($n in $namen) {
  $js_name = -join ($n.Split('-') | ForEach-Object { $_.Substring(0, 1).ToUpper() + $_.Substring(1) })
  $m = [regex]::Match($js, "const $js_name = \[\s*""svg"",\s*defaultAttributes,\s*\[(.*?)\n  \];", 'Singleline')
  if (-not $m.Success) { throw "Symbol nicht gefunden: $n" }
  [void]$sb.Append("<symbol id=""$n"" viewBox=""0 0 24 24"">")
  foreach ($t in [regex]::Matches($m.Groups[1].Value, '"(\w+)",\s*\{([^}]*)\}')) {
    $attr = ''
    foreach ($a in [regex]::Matches($t.Groups[2].Value, '(\w+): "([^"]*)"')) {
      if ($a.Groups[1].Value -ne 'key') { $attr += ' ' + $a.Groups[1].Value + '="' + $a.Groups[2].Value + '"' }
    }
    [void]$sb.Append('<' + $t.Groups[1].Value + $attr + '/>')
  }
  [void]$sb.AppendLine('</symbol>')
}
[void]$sb.AppendLine('</svg>')
$ziel = Join-Path $PSScriptRoot '..\app\web\symbole.svg'
[IO.File]::WriteAllText($ziel, $sb.ToString(), (New-Object Text.UTF8Encoding $false))
"$($namen.Count) Symbole nach $ziel geschrieben"

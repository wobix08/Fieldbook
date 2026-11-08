# Baut "Fieldbook.exe" (mit Symbol) in den Hauptordner.
# Nutzt nur, was in Windows schon steckt: .NET Framework mit dem C#-Compiler csc.exe.
# -Version schreibt Produktname und Version in die Dateieigenschaften (für Signatur und Virenschutz wichtig).
param([string]$Ziel = (Split-Path -Parent $PSScriptRoot), [string]$Version = '0.0.0')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ico = Join-Path $PSScriptRoot 'icon.ico'

function Zeichne([int]$g) {
    $bmp = New-Object Drawing.Bitmap $g, $g
    $gr = [Drawing.Graphics]::FromImage($bmp)
    $gr.SmoothingMode = 'AntiAlias'
    $f = $g / 64.0
    $gr.ScaleTransform($f, $f)
    $pfad = New-Object Drawing.Drawing2D.GraphicsPath
    $r = 14
    $pfad.AddArc(0, 0, $r * 2, $r * 2, 180, 90); $pfad.AddArc(64 - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $pfad.AddArc(64 - $r * 2, 64 - $r * 2, $r * 2, $r * 2, 0, 90); $pfad.AddArc(0, 64 - $r * 2, $r * 2, $r * 2, 90, 90)
    $pfad.CloseFigure()
    $gr.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(159, 183, 143))), $pfad)
    # Logo wie app\web\icon.svg (24er-Raster): aufgeschlagenes Buch, dessen Seiten einen Bergkamm bilden.
    # Kleine Größen bekommen dickere Linien und mehr Fläche, damit das Zeichen lesbar bleibt.
    if ($g -le 32) { $s = 2.15; $breite = 2.4 } else { $s = 1.75; $breite = 1.6 }
    $o = (64 - 24 * $s) / 2
    $gr.TranslateTransform($o, $o); $gr.ScaleTransform($s, $s)
    $logo = New-Object Drawing.Drawing2D.GraphicsPath
    $logo.StartFigure(); $logo.AddBezier(12, 20, 9.4, 18.3, 6, 17.9, 2, 18.5)
    $logo.AddLines([Drawing.PointF[]]@((New-Object Drawing.PointF 2, 18.5), (New-Object Drawing.PointF 2, 9.6), (New-Object Drawing.PointF 5.6, 6.9), (New-Object Drawing.PointF 7.8, 8.6), (New-Object Drawing.PointF 12, 4)))
    $logo.StartFigure(); $logo.AddBezier(12, 20, 14.6, 18.3, 18, 17.9, 22, 18.5)
    $logo.AddLines([Drawing.PointF[]]@((New-Object Drawing.PointF 22, 18.5), (New-Object Drawing.PointF 22, 9.6), (New-Object Drawing.PointF 18, 6), (New-Object Drawing.PointF 16, 7.8), (New-Object Drawing.PointF 12, 4)))
    $logo.StartFigure(); $logo.AddLine(12, 4, 12, 20)
    $stift = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(28, 29, 27)), $breite
    $stift.StartCap = 'Round'; $stift.EndCap = 'Round'; $stift.LineJoin = 'Round'
    $gr.DrawPath($stift, $logo)
    $gr.Dispose()
    return $bmp
}

# ICO-Datei mit mehreren Grössen (PNG-Einträge) schreiben
$groessen = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($g in $groessen) { $ms = New-Object IO.MemoryStream; (Zeichne $g).Save($ms, [Drawing.Imaging.ImageFormat]::Png); , $ms.ToArray() }
$fs = [IO.File]::Create($ico)
$bw = New-Object IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$groessen.Count)
$offset = 6 + 16 * $groessen.Count
for ($i = 0; $i -lt $groessen.Count; $i++) {
    $g = $groessen[$i]; $b = if ($g -ge 256) { 0 } else { $g }
    $bw.Write([byte]$b); $bw.Write([byte]$b); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$pngs[$i].Length); $bw.Write([UInt32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Close()

$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
$exe = Join-Path $Ziel 'Fieldbook.exe'
if ($Version -notmatch '^\d+(\.\d+){1,3}$') { throw "Ungültige Version: $Version" }
$versionCs = Join-Path ([IO.Path]::GetTempPath()) ("fieldbook-version-" + [guid]::NewGuid() + '.cs')
Set-Content -Path $versionCs -Encoding UTF8 -Value @(
    "[assembly: System.Reflection.AssemblyVersion(""$Version"")]",
    "[assembly: System.Reflection.AssemblyFileVersion(""$Version"")]",
    "[assembly: System.Reflection.AssemblyInformationalVersion(""$Version"")]")
try {
    & $csc /nologo /target:winexe /optimize+ "/win32icon:$ico" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$exe" (Join-Path $PSScriptRoot 'Starter.cs') $versionCs
    if ($LASTEXITCODE -ne 0) { throw "Kompilieren fehlgeschlagen" }
} finally { Remove-Item $versionCs -ErrorAction SilentlyContinue }
Write-Host "Erstellt: $exe"

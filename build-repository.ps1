# Baut das PixInsight-Script-Repository:
#   repository\<datum>-all.zip   enthaelt src\scripts\... (Pfade relativ zum PixInsight-Installationsordner)
#   repository\updates.xri       Paketliste mit SHA-1 (Datei, die PixInsight als Repository-URL abruft)
#
# Aufruf:  powershell -ExecutionPolicy Bypass -File build-repository.ps1
# Danach den Inhalt von "repository" auf einen Webserver legen (z.B. GitHub Pages)
# und die URL in PixInsight unter Resources > Updates > Manage Repositories eintragen.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root    = $PSScriptRoot
$srcDir  = Join-Path $root 'src'
$outDir  = Join-Path $root 'repository'
$date    = Get-Date
$stamp   = $date.ToString('yyyyMMdd')
$zipName = "$stamp-all.zip"
$zipPath = Join-Path $outDir $zipName

# ---- Metadaten (nach Bedarf anpassen) -------------------------------------
$repoTitle   = 'ASI2600 Scripts'
$repoDesc    = 'Persoenliche Sammlung von PixInsight-Skripten.'
$pkgTitle    = 'ASI2600 Scripts'
$pkgDesc     = 'Sammlung von PixInsight-Skripten (u.a. SXT ShiftAverage, SXT ShiftMedian).'
$pixVersion  = '1.8.9:2.0.0'   # unterstuetzter PixInsight-Versionsbereich
# ---------------------------------------------------------------------------

New-Item -ItemType Directory -Force $outDir | Out-Null
Get-ChildItem $outDir -Filter '*-all.zip' | Remove-Item -Force

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    Get-ChildItem $srcDir -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/]_[^\\/]*[\\/]' } | ForEach-Object {
        $rel = $_.FullName.Substring($srcDir.Length).TrimStart('\','/').Replace('\','/')
        $entryName = "src/$rel"
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName, 'Optimal')
        Write-Host "  + $entryName"
    }
} finally { $zip.Dispose() }

$sha1 = (Get-FileHash $zipPath -Algorithm SHA1).Hash.ToLower()
$rd   = $date.ToString('yyyy-MM-dd')

$xri = @"
<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <p>$repoDesc</p>
   </description>
   <title>$repoTitle</title>
   <package fileName="$zipName" sha1="$sha1" type="script">
      <title>$pkgTitle</title>
      <description>
         <p>$pkgDesc</p>
      </description>
      <platform os="all" arch="noarch" version="$pixVersion"/>
      <releaseDate>$rd</releaseDate>
   </package>
</xri>
"@
[System.IO.File]::WriteAllText((Join-Path $outDir 'updates.xri'), $xri, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Fertig: $zipPath"
Write-Host "SHA-1:  $sha1"

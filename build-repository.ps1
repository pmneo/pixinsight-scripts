# Builds the PixInsight script repository:
#   repository\<date>-all.zip   contains src\scripts\... (paths relative to the PixInsight installation folder)
#   repository\updates.xri      package list with SHA-1 (the file PixInsight fetches as the repository URL)
#
# Usage:  powershell -ExecutionPolicy Bypass -File build-repository.ps1
# Afterwards put the contents of "repository" on a web server (e.g. GitHub Pages)
# and enter the URL in PixInsight under Resources > Updates > Manage Repositories.

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

# ---- Metadata (adjust as needed) ------------------------------------------
$repoTitle   = 'ASI2600 Scripts'
$repoDesc    = 'Personal collection of PixInsight scripts.'
$pkgTitle    = 'ASI2600 Scripts'
$pkgDesc     = 'SXT Shift: StarXTerminator with a shifted tile grid, weighted mean and/or median, with dialog (requires StarXTerminator). Gaia Star Colors: recolors SHO stars with Gaia DR3 colors to get RGB stars (requires PixInsight 1.9.5 or newer).'
$pixVersion  = '1.8.9:2.0.0'   # supported PixInsight version range
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

Write-Host "Done: $zipPath"
Write-Host "SHA-1:  $sha1"

# Write the current commit into index.html, so a crash report names a build.
#
# `src/core/crash.js` reads `<meta name="cd-build">` and falls back to the document's
# lastModified — which on GitHub Pages is the deploy time and identifies nothing. A crash
# report that cannot name its build is a screenshot, not a bug report.
#
# ⚠ THE STAMP NAMES THE PARENT COMMIT, AND THAT IS EXACT RATHER THAN OFF BY ONE.
#
# Run this, then commit. The stamp therefore names the commit BEFORE the one that carries it
# — and the code it names is byte-identical to the code being pushed, because the stamping
# commit changes one meta tag and nothing else. What a reader wants from a build id is "which
# code was this", and that answer is exact. What it cannot tell you is whether the stamp
# itself was the last commit, which is not a question anybody asks.
#
# There is no build step in this repo — push is the deploy — so this is deliberately a
# separate command rather than a hook: a hook does not survive a clone, and a filter would
# make every checkout dirty.
#
#   powershell -ExecutionPolicy Bypass -File tools/stamp-build.ps1
#   powershell -ExecutionPolicy Bypass -File tools/stamp-build.ps1 -Check   # exit 1 if stale
param([switch]$Check)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$sha = (git rev-parse --short HEAD).Trim()
$when = (git log -1 --format=%cI).Trim()
$want = "$sha $when"

$path = Join-Path $root 'index.html'
# ⚠ READ AS UTF-8 EXPLICITLY. `Get-Content -Raw` decodes with the system ANSI codepage in
# PowerShell 5.1, so index.html's em-dashes came back as three Latin-1 characters each — and
# writing those out as UTF-8 double-encoded them. The first run of this script turned the
# page title into "Containment Detail Ã¢â‚¬â€ cold storage". Both ends have to say UTF-8:
# getting one right is how you produce mojibake rather than avoid it.
$html = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))

$rx = '<meta name="cd-build" content="([^"]*)">'
$m = [regex]::Match($html, $rx)

if ($Check) {
  if (-not $m.Success) { Write-Host "index.html carries no cd-build meta." -ForegroundColor Red; exit 1 }
  if ($m.Groups[1].Value -eq $want) { Write-Host "Stamp is current: $want"; exit 0 }
  Write-Host "Stamp is stale: '$($m.Groups[1].Value)' but HEAD is '$want'" -ForegroundColor Yellow
  exit 1
}

if ($m.Success) {
  $html = [regex]::Replace($html, $rx, "<meta name=`"cd-build`" content=`"$want`">")
} else {
  # Insert directly after <head>, so it is present before any script can throw.
  $html = $html -replace '(?i)(<head[^>]*>)', "`$1`n  <meta name=`"cd-build`" content=`"$want`">"
}

# ⚠ NOT `Set-Content -Encoding utf8`. In PowerShell 5.1 that writes a BYTE ORDER MARK, and
# the first run of this script put EF BB BF at the top of index.html. A BOM is tolerated in
# HTML and is not tolerated everywhere: three content files in this repo carried one, passed
# every PowerShell check, and would be rejected by any JSON parser that is not a browser.
# `-Encoding ANSI` is worse — index.html has non-ASCII in it and ANSI is how mojibake ships.
# UTF8Encoding($false) is the only one that means what "utf8" is supposed to mean.
[System.IO.File]::WriteAllText($path, $html, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Stamped index.html with $want" -ForegroundColor Green

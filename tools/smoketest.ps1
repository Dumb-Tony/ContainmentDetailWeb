# Airport Baggage Crew - headless smoke test.
#
# There is no Node.js on this machine, so the harness IS a browser (Dev\INDEX.md ->
# Testing). Copied from SomethingsDifferent\tools\smoketest.ps1 and adapted: this game is
# ES modules, so the injected suite must be type="module" or its imports will not resolve.
#
# It builds a scratch copy of index.html with the suite injected after main.js, serves it
# over http, drives it in headless Chrome, and greps the dumped DOM for the result block.
# Module scripts execute in document order, so the suite always runs AFTER main.js has
# booted and published window.__ABC.
#
#   .\tools\smoketest.ps1                          run the milestone-0 suite
#   .\tools\smoketest.ps1 -Tests tools\m1-tests.js -Keep
param(
  [string]$Tests = "tools\m0-tests.js",
  [string]$Game  = "index.html",
  [int]$Port     = 8379,
  [switch]$Keep
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Host "Chrome not found." -ForegroundColor Red; exit 2 }

$gamePath = Join-Path $root $Game
$testPath = Join-Path $root $Tests
if (-not (Test-Path $gamePath)) { Write-Host "Game not found: $gamePath" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $testPath)) { Write-Host "Tests not found: $testPath" -ForegroundColor Red; exit 2 }

# Scratch copy in the served root, so every relative module path still resolves.
# -Encoding UTF8 is REQUIRED: PS 5.1's Get-Content defaults to ANSI, so a UTF-8 source
# file round-trips into double-encoded mojibake and the test runs against a corrupt copy.
$scratchName = "_smoketest.html"
$scratch = Join-Path $root $scratchName
$html = Get-Content $gamePath -Raw -Encoding UTF8
if ($html -notmatch '</body>') { Write-Host "No </body> in $Game." -ForegroundColor Red; exit 2 }
$inject = "<script type=""module"" src=""$($Tests -replace '\\','/')""></script>`r`n</body>"
$html = $html -replace '</body>', $inject

# Stamp it. Other projects on this machine run this same harness with the same scratch
# filename, so "something answered 200 on the port" is NOT proof it is our server — it
# can silently run the wrong game's page and report its results as ours.
$stamp = "ABCTEST-" + [System.Guid]::NewGuid().ToString("N")
$html = $html -replace '</head>', "<!--$stamp--></head>"
Set-Content -Path $scratch -Value $html -Encoding utf8

. "$root\tools\_serve-mine.ps1"
$srv = Start-MyServer -Root $root -ScratchName $scratchName -Stamp $stamp -Ports @($Port, 8386, 8387, 8388, 8389)
if (-not $srv) {
  Write-Host "Could not get a port serving this project." -ForegroundColor Red
  exit 2
}
$server = $srv.Process
$url = $srv.Url

# NOTE: chrome.exe is a GUI-subsystem binary, so `$x = & chrome --dump-dom` captures
# NOTHING under PowerShell - the DOM has to be redirected to a file. Do not "simplify"
# this back to a direct capture; it silently cost an hour on the last project.
$profileDir = Join-Path $env:TEMP ("abc-smoke-" + [System.Guid]::NewGuid().ToString("N").Substring(0,8))
$domFile    = Join-Path $env:TEMP ("abc-dom-"   + [System.Guid]::NewGuid().ToString("N").Substring(0,8) + ".html")
$proc = Start-Process $chrome -ArgumentList `
  "--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
  "--user-data-dir=$profileDir","--window-size=1280,720",
  "--autoplay-policy=no-user-gesture-required",
  "--virtual-time-budget=90000","--dump-dom",$url `
  -RedirectStandardOutput $domFile -NoNewWindow -Wait -PassThru

if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
try { Remove-Item -Recurse -Force $profileDir -ErrorAction Stop } catch {}
if (-not $Keep) { try { Remove-Item $scratch -Force -ErrorAction Stop } catch {} }

$text = ""
if (Test-Path $domFile) { $text = Get-Content $domFile -Raw -Encoding UTF8 }
try { Remove-Item $domFile -Force -ErrorAction Stop } catch {}
if (-not $text) { $text = "" }

$m = [regex]::Match($text, '==ABCTEST-BEGIN==(.*?)==ABCTEST-END==', 'Singleline')
if (-not $m.Success) {
  Write-Host "No test output found - the page probably crashed before the harness ran." -ForegroundColor Red
  $eb = [regex]::Match($text, 'id="err-banner"[^>]*>(.*?)</div>', 'Singleline')
  if ($eb.Success) { Write-Host ("Error banner: " + $eb.Groups[1].Value.Trim()) -ForegroundColor Red }
  exit 1
}

$body = $m.Groups[1].Value.Trim() -replace '&lt;','<' -replace '&gt;','>' -replace '&amp;','&'
foreach ($line in ($body -split "`n")) {
  $t = $line.Trim()
  if ($t -like 'FAIL*')          { Write-Host $t -ForegroundColor Red }
  elseif ($t -like 'PASS*')      { Write-Host $t -ForegroundColor DarkGray }
  elseif ($t -like '*ALL-PASS*') { Write-Host $t -ForegroundColor Green }
  elseif ($t -like '*FAILURES*') { Write-Host $t -ForegroundColor Red }
  else                           { Write-Host $t }
}
if ($body -match 'ALL-PASS') { exit 0 } else { exit 1 }

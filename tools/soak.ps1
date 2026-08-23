# Containment Detail - the soak test.
#
# tools\bench.ps1 measures a frame. This measures an hour. GDD 23 Milestone 6 gates on
# "crash, performance, networking and save-migration thresholds met" and 26.4 asks for a
# stable 30-45 minute public-quality session; a frame budget cannot answer either, because
# the failure mode at forty minutes is not a slow frame, it is a list nobody pruned.
#
# It runs every shipped Incident Package forward for a long SIMULATED duration with a bot
# that plays - walks, calls, deploys, images, and takes snapshots at the shipped rate - and
# reports how fast every countable thing in the game grows, per simulated minute. Anything
# still climbing at the same rate when the run ends is the verdict.
#
# Same shape as bench.ps1, and for the same reasons: it REPLACES src/main.js rather than
# injecting alongside it (main.js would boot a second game competing for the same CPU), the
# scratch page is keyed to the port so two concurrent runs cannot rewrite each other's page,
# and the page is stamped so "something answered 200" is not mistaken for "our server did".
#
# --virtual-time-budget is kept for the reason bench.ps1 documents at length: it does not
# freeze the clock through synchronous work, and what it actually does is make --dump-dom
# WAIT for the page instead of racing it. A soak is a long synchronous run and losing the
# result to a race would waste the whole thing.
#
#   .\tools\soak.ps1                                20 simulated minutes x 7 incidents
#   .\tools\soak.ps1 -Minutes 60                    an hour each
#   .\tools\soak.ps1 -Minutes 45 -Incident cold-storage-tally
#   .\tools\soak.ps1 -Operatives 5 -NoRender        a full squad, no GPU counters
#
# Exit 0 when nothing was still growing, 1 when something was, 2 when it could not run.
#
# NOTE ON POWERSHELL 5.1: no 2>&1 on a native command anywhere in this file. In 5.1 that
# wraps every stderr line in an ErrorRecord and sets $? false on exit code 0, so the run
# dies on Chrome's harmless "Missing value path for key ... Extensions" warning.
param(
  [int]$Minutes     = 20,
  [int]$Operatives  = 3,
  [string]$Incident = "",
  [switch]$NoRender,
  [string]$Game     = "index.html",
  [int]$Port        = 8471,
  [switch]$Keep
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Host "Chrome not found." -ForegroundColor Red; exit 2 }

$gamePath = Join-Path $root $Game
$soakPath = Join-Path $root "tools\soak.js"
if (-not (Test-Path $gamePath)) { Write-Host "Game not found: $gamePath" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $soakPath)) { Write-Host "tools\soak.js not found." -ForegroundColor Red; exit 2 }

# -Encoding UTF8 is REQUIRED on the read: PS 5.1's Get-Content defaults to ANSI, so a UTF-8
# source round-trips into double-encoded mojibake and the run measures a corrupt copy.
$scratchName = "_soak-$Port.html"
$scratch = Join-Path $root $scratchName
$html = Get-Content $gamePath -Raw -Encoding UTF8
$mainTag = '<script type="module" src="src/main.js"></script>'
if ($html -notmatch [regex]::Escape($mainTag)) {
  Write-Host "Could not find the main.js script tag in $Game - has the boot changed?" -ForegroundColor Red
  exit 2
}
$html = $html.Replace($mainTag, '<script type="module" src="tools/soak.js"></script>')
$stamp = "CDSOAK-" + [System.Guid]::NewGuid().ToString("N")
$html = $html -replace '</head>', "<!--$stamp--></head>"
Set-Content -Path $scratch -Value $html -Encoding utf8

. "$root\tools\_serve-mine.ps1"
$srv = Start-MyServer -Root $root -ScratchName $scratchName -Stamp $stamp -Ports @($Port, ($Port + 1), ($Port + 2), ($Port + 3), ($Port + 4))
if (-not $srv) {
  Write-Host "Could not get a port serving this project." -ForegroundColor Red
  if (-not $Keep) { try { Remove-Item $scratch -Force -ErrorAction Stop } catch {} }
  exit 2
}
$server = $srv.Process

# The run is configured through the URL, so a longer soak never needs a code change - and
# the URL is printed, so the exact run can be reproduced in a real browser by hand.
$q = "minutes=$Minutes&ops=$Operatives"
if ($Incident) { $q += "&incident=$Incident" }
if ($NoRender) { $q += "&render=0" }
# ⚠ NO `(if ...)` AS AN EXPRESSION. PowerShell 5.1 parses a bare `if` in an expression slot
# as an error; the subexpression operator is required, and `$(...)` is the whole difference.
$sep = "?"
if ($srv.Url -match '\?') { $sep = "&" }
$url = $srv.Url + $sep + $q
# ⚠ COUNTED, NOT REMEMBERED. This was `= 7`, written when there were seven, and it is not
# only a banner: it sizes the virtual-time budget below. Two incidents were added and the
# run was given seven incidents' worth of time to do nine incidents' work — the shape of
# failure being a soak that stops early and reports that nothing was still growing, which
# is what a soak says when it passes.
$incidentCount = @(Get-ChildItem (Join-Path $root 'content\incidents') -Filter *.json -ErrorAction SilentlyContinue).Count
if ($incidentCount -lt 1) { $incidentCount = 7 }
if ($Incident) { $incidentCount = 1 }

Write-Host "  soaking $url" -ForegroundColor DarkGray
Write-Host "  $Minutes simulated minutes x $incidentCount incident(s), $Operatives operative(s)" -ForegroundColor DarkGray

# The wall-clock budget. A soak is a long synchronous run and Chrome has to be allowed to
# finish it; virtual time makes --dump-dom wait, and this is the ceiling on that wait.
# Sized from measurement rather than guessed: ~1.6 s of wall clock per simulated minute per
# incident on this machine with the renderer on, so 20 x 7 is about four minutes.
$budgetMs = [int](($Minutes * $incidentCount * 2500) + 120000)

$profileDir = Join-Path $env:TEMP ("cd-soak-" + [System.Guid]::NewGuid().ToString("N").Substring(0,8))
$domFile    = Join-Path $env:TEMP ("cd-sdom-" + [System.Guid]::NewGuid().ToString("N").Substring(0,8) + ".html")

# NOTE: chrome.exe is a GUI-subsystem binary, so `$x = & chrome --dump-dom` captures NOTHING
# under PowerShell - the DOM has to be redirected to a file. Do not "simplify" this back to
# a direct capture; it silently cost an hour on the last project.
$chromeArgs = @(
  "--headless=new","--no-first-run","--no-default-browser-check",
  "--user-data-dir=$profileDir","--window-size=1280,720",
  "--autoplay-policy=no-user-gesture-required",
  "--virtual-time-budget=$budgetMs","--dump-dom", $url
)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Start-Process $chrome -ArgumentList $chromeArgs -RedirectStandardOutput $domFile -NoNewWindow -Wait | Out-Null
$sw.Stop()

if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
try { Remove-Item -Recurse -Force $profileDir -ErrorAction Stop } catch {}
if (-not $Keep) { try { Remove-Item $scratch -Force -ErrorAction Stop } catch {} }

$text = ""
if (Test-Path $domFile) { $text = Get-Content $domFile -Raw -Encoding UTF8 }
try { Remove-Item $domFile -Force -ErrorAction Stop } catch {}
if (-not $text) { $text = "" }

Write-Host ""
Write-Host ("=== soak ({0:N1} s wall) ===" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Cyan

$m = [regex]::Match($text, '==CDSOAK-BEGIN==(.*?)==CDSOAK-END==', 'Singleline')
if (-not $m.Success) {
  Write-Host "No soak output found - the page crashed, or the run outran the time budget." -ForegroundColor Red
  $eb = [regex]::Match($text, 'id="err-banner"[^>]*>(.*?)</div>', 'Singleline')
  if ($eb.Success) { Write-Host ("Error banner: " + $eb.Groups[1].Value.Trim()) -ForegroundColor Red }
  exit 1
}

$body = $m.Groups[1].Value.Trim() -replace '&lt;','<' -replace '&gt;','>' -replace '&amp;','&'
foreach ($line in ($body -split "`n")) {
  $t = $line.TrimEnd()
  if ($t -like '*STILL GROWING*')     { Write-Host $t -ForegroundColor Red }
  elseif ($t -like '*slowing*')       { Write-Host $t -ForegroundColor Yellow }
  elseif ($t -like '---*')            { Write-Host $t -ForegroundColor Cyan }
  elseif ($t -like '*ABORTED*')       { Write-Host $t -ForegroundColor Red }
  elseif ($t -like '=== verdict ===') { Write-Host $t -ForegroundColor Cyan }
  else                                { Write-Host $t }
}

if ($body -match 'SOAK ABORTED') { exit 1 }
if ($body -match 'still climbing') {
  Write-Host ""
  Write-Host "SOAK FAILED - something is unbounded. Read the STILL GROWING rows above." -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "SOAK PASSED - nothing was still growing when the run ended." -ForegroundColor Green
exit 0

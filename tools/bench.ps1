# Containment Detail (browser build) - the wall-clock performance harness.
#
# GDD §23 Milestone 3 gates on "performance, network, crash and licensing gates pass" and
# §27.3 on "performance and network budgets pass with a full squad". Those are numbers, not
# assertions, and `tools\smoketest.ps1` cannot produce them: it asserts WORK (how many
# occluder sweeps, how many samples), which is the right thing for a suite to assert and
# says nothing about milliseconds. This says milliseconds.
#
# Same shape as smoketest.ps1 — scratch page keyed to the port, stamped, served by
# _serve-mine.ps1, driven with --dump-dom, result greped out of the dumped DOM. Three
# things differ, and each of them had to:
#
#   1. It REPLACES src/main.js rather than injecting alongside it. main.js boots a whole
#      game: a WebGL context on the same canvas, a requestAnimationFrame loop, an audio
#      graph and a net session, all of which would be competing for the CPU being measured.
#
#   2. It does NOT pass --disable-gpu. Measured on this machine, --disable-gpu puts WebGL
#      on "Microsoft Basic Render Driver" and leaving it off gets the real adapter; a
#      render figure from a software rasteriser is not a render figure. The page prints
#      which one it got.
#
#   3. It runs the whole benchmark TWICE by default and prints the spread between the runs.
#      A benchmark that is not reproducible is not evidence, and the only way to know is to
#      do it twice and look.
#
# ⚠ --virtual-time-budget IS KEPT, DELIBERATELY, and the reason is the opposite of the one
# usually given. It was blamed for the "every timing reads 0.000us" result; it is not the
# cause. Measured, same synchronous benchmark, this Chrome: 4e7 iterations read 277.4 ms of
# performance.now() with real time and 276.6 ms with virtual time, and Date.now() agreed
# with both to a millisecond. The 0.000 came from the timer's 100 MICROSECOND quantisation
# on a page that is not cross-origin isolated, which no browser flag fixes and which
# bench.js defeats by timing batches. What virtual time actually does is make --dump-dom
# WAIT: with real time a run was measured losing its result completely, because the page's
# async continuation landed after the load event and the DOM was dumped without it. Use
# -RealTime to check that for yourself; bench.js prints the clock cross-check either way
# and refuses to report numbers if the two clocks ever disagree.
#
#   .\tools\bench.ps1                       two runs, all five incidents
#   .\tools\bench.ps1 -Runs 1 -Keep         one run, keep the scratch page
#   .\tools\bench.ps1 -RealTime             no virtual time (may lose the result)
param(
  [string]$Bench = "tools\bench.js",
  [string]$Game  = "index.html",
  [int]$Port     = 8451,
  [int]$Runs     = 2,
  [switch]$RealTime,
  [switch]$Keep
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Host "Chrome not found." -ForegroundColor Red; exit 2 }

$gamePath  = Join-Path $root $Game
$benchPath = Join-Path $root $Bench
if (-not (Test-Path $gamePath))  { Write-Host "Game not found: $gamePath" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $benchPath)) { Write-Host "Benchmark not found: $benchPath" -ForegroundColor Red; exit 2 }

# Scratch copy in the served root, so every relative module path still resolves, and keyed
# to the port so two concurrent runs cannot rewrite each other's page between the write and
# the fetch. Same reasoning as smoketest.ps1, and the same reason -Encoding UTF8 is on the
# read: PS 5.1's Get-Content defaults to ANSI and would double-encode the source.
$scratchName = "_bench-$Port.html"
$scratch = Join-Path $root $scratchName
$html = Get-Content $gamePath -Raw -Encoding UTF8
$mainTag = '<script type="module" src="src/main.js"></script>'
if ($html -notmatch [regex]::Escape($mainTag)) {
  Write-Host "Could not find the main.js script tag in $Game - has the boot changed?" -ForegroundColor Red
  exit 2
}
$benchSrc = $Bench -replace '\\','/'
$html = $html.Replace($mainTag, "<script type=""module"" src=""$benchSrc""></script>")

# Stamp it. Other projects on this machine run this same tooling with the same scratch
# filenames, so "something answered 200 on the port" is not proof it is our server.
$stamp = "CDBENCH-" + [System.Guid]::NewGuid().ToString("N")
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
$url = $srv.Url

if ($RealTime) { Write-Host "  real time - the dump may race the benchmark and come back empty" -ForegroundColor DarkYellow }
Write-Host "  benching $url" -ForegroundColor DarkGray

$allData = @()
$ok = $true
for ($run = 1; $run -le $Runs; $run++) {
  # NOTE: chrome.exe is a GUI-subsystem binary, so `$x = & chrome --dump-dom` captures
  # NOTHING under PowerShell - the DOM has to be redirected to a file. Do not "simplify"
  # this back to a direct capture; it silently cost an hour on the last project.
  $profileDir = Join-Path $env:TEMP ("cd-bench-" + [System.Guid]::NewGuid().ToString("N").Substring(0,8))
  $domFile    = Join-Path $env:TEMP ("cd-bdom-"  + [System.Guid]::NewGuid().ToString("N").Substring(0,8) + ".html")

  $chromeArgs = @(
    "--headless=new","--no-first-run","--no-default-browser-check",
    "--user-data-dir=$profileDir","--window-size=1280,720",
    "--autoplay-policy=no-user-gesture-required","--dump-dom"
  )
  if (-not $RealTime) { $chromeArgs += "--virtual-time-budget=900000" }
  $chromeArgs += $url

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Start-Process $chrome -ArgumentList $chromeArgs -RedirectStandardOutput $domFile -NoNewWindow -Wait | Out-Null
  $sw.Stop()
  try { Remove-Item -Recurse -Force $profileDir -ErrorAction Stop } catch {}

  $text = ""
  if (Test-Path $domFile) { $text = Get-Content $domFile -Raw -Encoding UTF8 }
  try { Remove-Item $domFile -Force -ErrorAction Stop } catch {}
  if (-not $text) { $text = "" }

  Write-Host ""
  Write-Host ("=== run $run of $Runs  ({0:N1} s) ===" -f ($sw.Elapsed.TotalSeconds)) -ForegroundColor Cyan

  $m = [regex]::Match($text, '==CDBENCH-BEGIN==(.*?)==CDBENCH-END==', 'Singleline')
  if (-not $m.Success) {
    Write-Host "No benchmark output found - the page crashed, or the dump raced it." -ForegroundColor Red
    $eb = [regex]::Match($text, 'id="err-banner"[^>]*>(.*?)</div>', 'Singleline')
    if ($eb.Success) { Write-Host ("Error banner: " + $eb.Groups[1].Value.Trim()) -ForegroundColor Red }
    $ok = $false
    continue
  }

  $body = $m.Groups[1].Value.Trim() -replace '&lt;','<' -replace '&gt;','>' -replace '&amp;','&'
  foreach ($line in ($body -split "`n")) {
    $t = $line.TrimEnd()
    if ($t -like '*FAIL*')                { Write-Host $t -ForegroundColor Red }
    elseif ($t -like '*PASS*')            { Write-Host $t -ForegroundColor Green }
    elseif ($t -like '---*')              { Write-Host $t -ForegroundColor Cyan }
    elseif ($t -like '*BENCH-COMPLETE*')  { Write-Host $t -ForegroundColor Green }
    else                                  { Write-Host $t }
  }
  if ($body -match 'INSTRUMENT FAILED' -or $body -match 'BENCH ABORTED') { $ok = $false }

  # The machine-readable copy, for the spread below. Every row is
  # <key fields...>|<median>|<worst>, so the key is everything except the last two - the
  # key fields vary in number and slicing a fixed three of them silently merged the
  # one-operative and five-operative rows into one entry.
  $d = [regex]::Match($text, '==CDBENCH-DATA==(.*?)==CDBENCH-DATA-END==', 'Singleline')
  $table = @{}
  if ($d.Success) {
    foreach ($row in ($d.Groups[1].Value -split "`n")) {
      $parts = ($row.Trim() -replace '&amp;','&') -split '\|'
      if ($parts.Count -lt 3) { continue }
      $key = ($parts[0..($parts.Count - 3)]) -join '|'
      $table[$key] = [double]$parts[$parts.Count - 2]
    }
  }
  $allData += ,$table
}

if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
if (-not $Keep) { try { Remove-Item $scratch -Force -ErrorAction Stop } catch {} }

# The spread. Two runs that disagree by tens of percent are not two measurements of one
# thing, and a table that does not say so is worse than no table.
if ($allData.Count -ge 2) {
  Write-Host ""
  Write-Host "=== run-to-run spread (medians) ===" -ForegroundColor Cyan
  # ⚠ ONLY MEASUREMENTS THAT ARE BIG ENOUGH TO MEAN ANYTHING. `stepCustody` costs about
  # forty NANOSECONDS; two runs reading 0.03us and 0.05us is a two-tick difference on a
  # clock whose tick is 0.1us divided by the batch, and reporting it as an "85% spread"
  # buried the fact that everything a budget cares about agreed to within a few percent.
  # One microsecond is the floor, and it is not arbitrary: a microsecond is 0.006% of a
  # 16.67ms frame, so nothing under it can move a budget however wrong it is.
  #
  # The machine's own variation, measured by the same reference loop in every run. It is
  # the floor under every other spread here: if the CPU was 12% slower for one run then
  # everything measured in that run is about 12% slower, and no amount of care in the page
  # can subtract that.
  $ref = @()
  foreach ($t in $allData) { if ($t.ContainsKey('machine|reference-loop')) { $ref += $t['machine|reference-loop'] } else { $ref += 0 } }
  $cleanest = 0
  if (($ref | Where-Object { $_ -gt 0 }).Count -ge 2) {
    $rmin = ($ref | Where-Object { $_ -gt 0 } | Measure-Object -Minimum).Minimum
    $rmax = ($ref | Measure-Object -Maximum).Maximum
    for ($i = 0; $i -lt $ref.Count; $i++) { if ($ref[$i] -eq $rmin) { $cleanest = $i + 1 } }
    Write-Host ("  machine baseline: reference loop {0:N0}-{1:N0} ms across runs, {2:N1}% apart - run {3} was the least loaded" -f $rmin, $rmax, (100 * ($rmax - $rmin) / $rmin), $cleanest)
  }

  $floorMs = 0.001
  $keys = $allData[0].Keys | Sort-Object
  $worstKey = $null; $worstPct = 0; $n = 0; $sumPct = 0; $skipped = 0
  foreach ($k in $keys) {
    if ($k -eq 'machine|reference-loop') { continue }
    $vals = @()
    $have = $true
    foreach ($t in $allData) { if ($t.ContainsKey($k)) { $vals += $t[$k] } else { $have = $false } }
    if (-not $have -or $vals.Count -lt 2) { continue }
    $min = ($vals | Measure-Object -Minimum).Minimum
    $max = ($vals | Measure-Object -Maximum).Maximum
    if ($min -le 0) { continue }
    if ($max -lt $floorMs) { $skipped++; continue }
    $pct = 100 * ($max - $min) / $min
    $n++; $sumPct += $pct
    if ($pct -gt $worstPct) { $worstPct = $pct; $worstKey = $k }
  }
  if ($n -gt 0) {
    Write-Host ("  {0} measurements compared across {1} runs ({2} skipped as under 1 us)" -f $n, $allData.Count, $skipped)
    Write-Host ("  mean spread  {0:N1}%" -f ($sumPct / $n))
    Write-Host ("  worst spread {0:N1}%  on  {1}" -f $worstPct, $worstKey)
    if ($worstPct -gt 35) {
      Write-Host "  !! wide. This machine is shared: another Chrome, a build or a test suite running" -ForegroundColor Yellow
      Write-Host "     alongside shows up as every measurement in one run being slower in the same" -ForegroundColor Yellow
      Write-Host "     direction. Read the headline table below, where the MINIMUM is the figure taken" -ForegroundColor Yellow
      Write-Host "     from the least disturbed run." -ForegroundColor Yellow
    }
  }

  # The headline numbers, run by run. Contention on a shared machine only ever makes a
  # measurement SLOWER, so the minimum across runs is the closest any of them got to the
  # cost of the code by itself - and seeing every run's value next to it is what makes
  # that claim checkable rather than a choice of the flattering number.
  Write-Host ""
  Write-Host "=== headline, run by run (ms) ===" -ForegroundColor Cyan
  $head = @()
  foreach ($k in ($allData[0].Keys | Sort-Object)) {
    if ($k -like 'frame|*' -or $k -like 'step|*|5') { $head += $k }
  }
  $hdr = "  measurement                                    "
  for ($i = 1; $i -le $allData.Count; $i++) { $hdr += ("run {0,-6}" -f $i) }
  Write-Host ($hdr + "   min")
  foreach ($k in $head) {
    $row = "  " + $k.PadRight(46)
    $vals = @()
    foreach ($t in $allData) {
      if ($t.ContainsKey($k)) { $vals += $t[$k]; $row += ("{0,-10:N3}" -f $t[$k]) } else { $row += "-         " }
    }
    if ($vals.Count -gt 0) { $row += ("   {0:N3}" -f ($vals | Measure-Object -Minimum).Minimum) }
    Write-Host $row
  }
}

if ($ok) { exit 0 } else { exit 1 }

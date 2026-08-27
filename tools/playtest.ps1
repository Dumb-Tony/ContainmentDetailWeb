# Run the friend test: tools/playtest.js drives the shipped page through clicks and keys
# in headless Chrome, photographing the canvas as it goes. See that file's header.
#
# Real time, no --dump-dom, no virtual budget -- the page POSTs its report and its frames to
# serve.ps1's /__result endpoint (the bench's channel), this waits for the report, then
# decodes every frame into a PNG somebody can actually look at.
#
#   powershell -ExecutionPolicy Bypass -File tools/playtest.ps1
#   powershell -ExecutionPolicy Bypass -File tools/playtest.ps1 -OutDir C:\somewhere
#
# ⚠ THE STORY IS NOW TWO COMPLETE OPERATIONS (solo, then squad-host) played in real time:
# the draught walks to the lure at its own pace and custody must hold 30 true seconds,
# twice. A full green run is 20-35 minutes of wall clock (measured: the lure leg alone can
# take four real minutes per operation), so the default wait is sized for the story, not
# for a smoke test. The driver posts its report the moment it finishes; the wait is a
# ceiling, not a duration — and the driver also posts a ROLLING PARTIAL to slot 800, so a
# run that dies mid-story still leaves its measurements (see below).
param(
  [int]$Port = 8461,
  [int]$WaitSeconds = 2700,
  [string]$OutDir = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Host "Chrome not found." -ForegroundColor Red; exit 2 }
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP "cd-playtest" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }

$stamp = "CDPLAY-" + [System.Guid]::NewGuid().ToString("N")
$scratchName = "_playtest-$Port.html"
$scratch = Join-Path $root $scratchName
# BOM-less, like everything else other tools will read.
[System.IO.File]::WriteAllText($scratch, @"
<!doctype html><html><head><meta charset="utf-8"><!--$stamp--><title>playtest</title>
<style>body{margin:0;background:#0a0c10;color:#9ab;font:12px monospace}</style></head>
<body><script type="module" src="tools/playtest.js"></script></body></html>
"@, (New-Object System.Text.UTF8Encoding $false))

. "$root\tools\_serve-mine.ps1"
$srv = Start-MyServer -Root $root -ScratchName $scratchName -Stamp $stamp -Ports @($Port, ($Port + 1), ($Port + 2), ($Port + 3))
if (-not $srv) { Write-Host "No port." -ForegroundColor Red; exit 2 }

Get-ChildItem $root -Filter "_result-*.txt" -ErrorAction SilentlyContinue | Remove-Item -Force
$report = Join-Path $root "_result-$($srv.Port).txt"

$profileDir = Join-Path $env:TEMP ("cd-pt-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
$proc = Start-Process $chrome -ArgumentList @(
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=$profileDir", "--window-size=1400,1000",
  "--autoplay-policy=no-user-gesture-required", $srv.Url
) -NoNewWindow -PassThru

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while (-not (Test-Path $report) -and (Get-Date) -lt $deadline -and -not $proc.HasExited) {
  Start-Sleep -Milliseconds 500
}
Start-Sleep -Milliseconds 400
if (-not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force } catch {} }
try { Remove-Item -Recurse -Force $profileDir -ErrorAction Stop } catch {}

# Frames: slots 911+, first line label, rest a data URL.
$shots = 0
foreach ($f in Get-ChildItem $root -Filter "_result-9*.txt" | Sort-Object Name) {
  $t = Get-Content $f.FullName -Raw -Encoding UTF8
  $nl = $t.IndexOf("`n")
  if ($nl -lt 1) { continue }
  $label = $t.Substring(0, $nl).Trim()
  $data = $t.Substring($nl + 1).Trim()
  if ($data -match '^data:image/png;base64,(.+)$') {
    $png = Join-Path $OutDir "$label.png"
    [System.IO.File]::WriteAllBytes($png, [Convert]::FromBase64String($Matches[1]))
    $shots++
  }
  Remove-Item $f.FullName -Force
}

$partialFile = Join-Path $root "_result-800.txt"
if (Test-Path $report) {
  Get-Content $report -Encoding UTF8 | Write-Host
  Remove-Item $report -Force
  Write-Host ""
  Write-Host "$shots frame(s) written to $OutDir" -ForegroundColor Green
} elseif (Test-Path $partialFile) {
  # The run outlived the ceiling but the rolling partial holds everything measured up to
  # the last leg boundary — 25 minutes of PT lines died with the first timeout and this
  # is what keeps that from happening twice.
  Write-Host "NO FINAL REPORT (ceiling hit) -- printing the rolling partial:" -ForegroundColor Yellow
  Get-Content $partialFile -Encoding UTF8 | Write-Host
  Write-Host ""
  Write-Host "$shots frame(s) written to $OutDir" -ForegroundColor Yellow
} else {
  Write-Host "NO REPORT -- the driver never finished. Check the scratch page by hand." -ForegroundColor Red
}
if (Test-Path $partialFile) { try { Remove-Item $partialFile -Force } catch {} }
if ($srv.Process -and -not $srv.Process.HasExited) { try { Stop-Process -Id $srv.Process.Id -Force } catch {} }
try { Remove-Item $scratch -Force -ErrorAction Stop } catch {}

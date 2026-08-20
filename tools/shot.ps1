# Headless screenshot of the game, for docs and for eyeballing a render change.
# Adapted from SomethingsDifferent\tools\shot.ps1 (Dev\INDEX.md -> Tooling & testing).
#
#   .\tools\shot.ps1                                        title screen
#   .	oolsshot.ps1 -Setup tools_shot-fence.js -Out docsm0-fence.png
#
# -Setup injects a module that runs AFTER main.js, so it can pose the game through
# window.__CD before the frame is captured.
param(
  [string]$Setup = "",
  [string]$Out   = "docs\shot.png",
  [int]$Width    = 1600,
  [int]$Height   = 900,
  [int]$Port     = 8416
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Host "Chrome not found." -ForegroundColor Red; exit 2 }

$scratchName = "_shot.html"
$scratch = Join-Path $root $scratchName
$html = Get-Content (Join-Path $root "index.html") -Raw -Encoding UTF8
if ($Setup) {
  $inject = "<script type=""module"" src=""$($Setup -replace '\\','/')""></script>`r`n</body>"
  $html = $html -replace '</body>', $inject
}
# Stamp the scratch copy so the server check can prove the port is serving THIS project
# and not another game that happens to hold the port. See tools\_serve-mine.ps1.
$stamp = "CDSHOT-" + [System.Guid]::NewGuid().ToString("N")
$html = $html -replace '</head>', "<!--$stamp--></head>"
Set-Content -Path $scratch -Value $html -Encoding utf8

. "$root\tools\_serve-mine.ps1"
$srv = Start-MyServer -Root $root -ScratchName $scratchName -Stamp $stamp -Ports @($Port, 8417, 8418, 8419, 8420)
if (-not $srv) {
  Write-Host "Could not get a port serving this project." -ForegroundColor Red
  exit 2
}
$server = $srv.Process
$url = $srv.Url

$outPath = Join-Path $root $Out
$outDir = Split-Path $outPath -Parent
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force $outDir | Out-Null }
$profileDir = Join-Path $env:TEMP ("cd-shot-" + [System.Guid]::NewGuid().ToString("N").Substring(0,8))

Start-Process $chrome -ArgumentList `
  "--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
  "--user-data-dir=$profileDir","--window-size=$Width,$Height",
  "--hide-scrollbars","--virtual-time-budget=8000",
  "--screenshot=$outPath",$url -NoNewWindow -Wait

if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
try { Remove-Item -Recurse -Force $profileDir -ErrorAction Stop } catch {}
try { Remove-Item $scratch -Force -ErrorAction Stop } catch {}

if (Test-Path $outPath) {
  Write-Host "wrote $Out ($([math]::Round((Get-Item $outPath).Length/1kb)) kb)" -ForegroundColor Green
} else {
  Write-Host "screenshot failed" -ForegroundColor Red; exit 1
}

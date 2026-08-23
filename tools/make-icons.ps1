# Generate the install icons — GDD §23 Milestone 5.
#
# There were none in the repo, and the two ways to get one are both wrong for this build.
# Drawing a new logo invents a visual identity the game does not have; shrinking a screenshot
# produces mush, because a 1600x900 frame of a dark corridor squashed to 48px is a grey
# rectangle. So the icon is made out of something the build already owns:
#
#   THE MARK is `COMMS_KIND.evidence.glyph` from src/sim/comms.js — the character the comms
#   wheel already draws for evidence. It is a thing held inside a boundary, which is the
#   game's title in one character, and of the six glyphs in that set (danger, evidence,
#   objective, move, watch, help) it is the only one that is still unambiguous at 48px: a
#   heavy ring and a solid centre, no thin strokes, no diagonal, no interior detail to lose.
#
#   THE PALETTE is read out of index.html's :root at generation time rather than retyped, so
#   the icon cannot drift from the game. tools/platform-tests.js asserts the same match from
#   the other end.
#
#   THE PIPELINE is the one tools/shot.ps1 already uses: stamp a scratch page, serve it over
#   http through tools/_serve-mine.ps1 so the port is provably ours, and photograph it in
#   headless Chrome.
#
# 512 is rendered; 192 and 48 are resampled down from it. A ring and a dot is precisely the
# shape that survives bicubic resampling — there is no hinted text and no one-pixel detail —
# and rendering the small sizes natively risks Chrome clamping a 48x48 window.
#
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1 -Mark 96 -Nudge -2
param(
  # ⚠ ALL THREE ARE MEASURED, NOT CHOSEN BY EYE. The first render put the mark 11px low in a
  # 192px frame, because `align-items:center` centres a glyph's LINE BOX and U+25C9 does not
  # sit centred in its own em — it is a circle on the maths axis, above the baseline midpoint.
  # Nothing about that is visible at 512px and it is exactly what makes a small icon look
  # subtly wrong. So: render, measure the ink bounding box (tools/platform-tests.js F does the
  # same measurement from the other end and fails if it drifts), correct, render again.
  [double]$Mark  = 100,    # font-size of the glyph in vmin; yields a mark 72% of the frame
  [double]$Mask  = 84,     # ditto maskable, yielding 61% — inside the 80% safe circle
  [double]$Nudge = -5.7,   # vertical correction in vmin: 11px of 192 measured on render one
  [int]$Port     = 8426
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Host "Chrome not found." -ForegroundColor Red; exit 2 }

# ⚠ BOTH ENDS SAY UTF-8. Get-Content -Raw decodes with the system ANSI codepage in PS 5.1 and
# Set-Content -Encoding utf8 writes a BOM, and getting one of the two right is how the page
# title turned into "Containment Detail Ã¢â‚¬â€ cold storage" earlier this week. It matters
# more here than usual: the mark IS a non-ASCII character, and a mojibake glyph is an icon of
# a tofu box.
function Read-Utf8([string]$p) { [System.IO.File]::ReadAllText($p, (New-Object System.Text.UTF8Encoding $false)) }
function Write-Utf8([string]$p, [string]$s) { [System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding $false)) }

$html = Read-Utf8 (Join-Path $root 'index.html')
$comms = Read-Utf8 (Join-Path $root 'src\sim\comms.js')

# The palette, from the stylesheet that actually ships.
function Get-CssVar([string]$name) {
  $m = [regex]::Match($html, "--$([regex]::Escape($name))\s*:\s*(#[0-9a-fA-F]{3,8})")
  if (-not $m.Success) { Write-Host "index.html :root has no --$name" -ForegroundColor Red; exit 2 }
  $m.Groups[1].Value
}
$bg    = Get-CssVar 'bg'
$amber = Get-CssVar 'amber'
$panel = Get-CssVar 'panel'

# The mark, from the module that draws it.
$gm = [regex]::Match($comms, "evidence:\s*\{\s*glyph:\s*'([^']+)'")
if (-not $gm.Success) { Write-Host "src/sim/comms.js has no evidence glyph." -ForegroundColor Red; exit 2 }
$glyph = $gm.Groups[1].Value
Write-Host "palette --bg $bg / --amber $amber / --panel $panel   mark U+$([int][char]$glyph[0] | ForEach-Object { $_.ToString('X4') })"

# Segoe UI is index.html's --sans and does not carry U+25C9; the two Windows faces that do
# are appended so the fallback chain is stated rather than left to luck.
$fonts = '"Segoe UI Symbol","Segoe UI",Inter,"DejaVu Sans","Arial Unicode MS",sans-serif'

function Page([double]$size, [double]$nudge, [bool]$maskable) {
  # ⚠ THE FIELD IS FLAT, AND THAT IS A SIZE DECISION RATHER THAN A TASTE ONE. The first pass
  # laid --panel through the middle on a full-frame radial gradient. On screen it was
  # invisible against --bg; in the file it was 131 kb, because a smooth gradient is the one
  # thing PNG cannot compress — every row differs from the row above it. Flat --bg with the
  # glow confined to a tight ring around the mark looks the same and costs a tenth of that.
  # An icon has no business being a fifteenth of the whole download.
  #
  # The glow itself stays: it is the HUD's own idiom, the way index.html lights its power
  # indicators with `box-shadow:0 0 7px var(--green)`, and it is what keeps the mark from
  # reading as a sticker laid on black.
  $glow = if ($maskable) { $size * 0.62 } else { $size * 0.60 }
  $rim  = [math]::Round($size * 0.09, 1)
  @"
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>icon</title>
<style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:$bg}
  body{display:flex;align-items:center;justify-content:center}
  .glow{position:fixed;left:50%;top:calc(50% + ${nudge}vmin);width:${glow}vmin;height:${glow}vmin;
    transform:translate(-50%,-50%);border-radius:50%;
    background:radial-gradient(circle, ${amber}26 0%, transparent 66%)}
  .mark{position:relative;font-family:$fonts;font-size:${size}vmin;line-height:1;
    color:$amber;transform:translateY(${nudge}vmin);
    text-shadow:0 0 ${rim}vmin ${amber}5c}
</style></head>
<body><div class="glow"></div><div class="mark">$glyph</div></body></html>
"@
}

$iconDir = Join-Path $root 'assets\icons'
if (-not (Test-Path $iconDir)) { New-Item -ItemType Directory -Force $iconDir | Out-Null }

# One server for both renders. The stamp is what proves the port is serving THIS project and
# not another game on this machine holding 8426 — see tools/_serve-mine.ps1.
$stamp = "CDICON-" + [System.Guid]::NewGuid().ToString("N")
$anyName  = "_icon.html"
$maskName = "_icon-mask.html"
Write-Utf8 (Join-Path $root $anyName)  ((Page $Mark $Nudge $false) -replace '</head>', "<!--$stamp--></head>")
Write-Utf8 (Join-Path $root $maskName) ((Page $Mask $Nudge $true)  -replace '</head>', "<!--$stamp--></head>")

. "$root\tools\_serve-mine.ps1"
$srv = Start-MyServer -Root $root -ScratchName $anyName -Stamp $stamp -Ports @($Port, 8427, 8428, 8429, 8430)
if (-not $srv) { Write-Host "Could not get a port serving this project." -ForegroundColor Red; exit 2 }
$server = $srv.Process
$base = "http://localhost:$($srv.Port)"

function Shoot([string]$page, [string]$out) {
  $profileDir = Join-Path $env:TEMP ("cd-icon-" + [System.Guid]::NewGuid().ToString("N").Substring(0,8))
  Start-Process $chrome -ArgumentList `
    "--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
    "--user-data-dir=$profileDir","--window-size=512,512","--force-device-scale-factor=1",
    "--hide-scrollbars","--virtual-time-budget=4000",
    "--screenshot=$out","$base/$page" -NoNewWindow -Wait
  try { Remove-Item -Recurse -Force $profileDir -ErrorAction Stop } catch {}
  if (-not (Test-Path $out)) { Write-Host "render failed: $page" -ForegroundColor Red; exit 1 }
}

$any512  = Join-Path $iconDir 'icon-512.png'
$mask512 = Join-Path $iconDir 'icon-maskable-512.png'
Shoot $anyName  $any512
Shoot $maskName $mask512

if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
try { Remove-Item (Join-Path $root $anyName)  -Force -ErrorAction Stop } catch {}
try { Remove-Item (Join-Path $root $maskName) -Force -ErrorAction Stop } catch {}

Add-Type -AssemblyName System.Drawing
function Resize-Png([string]$src, [string]$dst, [int]$size) {
  $img = [System.Drawing.Image]::FromFile($src)
  try {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode    = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode      = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode        = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingQuality   = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally { $img.Dispose() }
}
Resize-Png $any512 (Join-Path $iconDir 'icon-192.png') 192
Resize-Png $any512 (Join-Path $iconDir 'icon-48.png')  48

# Report what was actually written, with numbers. A generator that says "done" and produced a
# blank square is the failure this whole file exists to avoid, so the ink is measured here as
# well as in the suite: the fraction of pixels that are nearer the mark than the field.
function Ink([string]$p) {
  $img = [System.Drawing.Bitmap]::FromFile($p)
  try {
    $lit = 0; $n = $img.Width * $img.Height
    for ($y = 0; $y -lt $img.Height; $y++) {
      for ($x = 0; $x -lt $img.Width; $x++) {
        $c = $img.GetPixel($x, $y)
        if (($c.R + $c.G + $c.B) -gt 200) { $lit++ }
      }
    }
    [math]::Round(100 * $lit / $n, 1)
  } finally { $img.Dispose() }
}
foreach ($f in @('icon-48.png','icon-192.png','icon-512.png','icon-maskable-512.png')) {
  $p = Join-Path $iconDir $f
  $kb = [math]::Round((Get-Item $p).Length / 1kb, 1)
  Write-Host ("  {0,-24} {1,6} kb   ink {2,4}%" -f $f, $kb, (Ink $p)) -ForegroundColor Green
}

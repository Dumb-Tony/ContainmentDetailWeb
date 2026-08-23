# Containment Detail (browser build) dev server.
#
# Serving over http is REQUIRED, not a convenience: the game is ES modules, and browsers
# block module loads on file:// (CORS). GDD 21.1 asked for "open index.html"; that is not
# possible with modules, so this is the documented substitute. See README.
#
# Ports 8401-8410, chosen to sit clear of every other dev server on this machine — see
# Dev/INDEX.md, where the 8381-8390 band already has three projects competing for it.
#   -NoBrowser   don't launch a browser tab (used by tools\smoketest.ps1)
#   -Port <n>    try this exact port instead of scanning 8401-8410
param([switch]$NoBrowser, [int]$Port = 0)
$root = Split-Path $PSScriptRoot -Parent
$mime = @{ ".html"="text/html"; ".js"="text/javascript"; ".mjs"="text/javascript";
           ".css"="text/css"; ".json"="application/json"; ".png"="image/png";
           ".jpg"="image/jpeg"; ".svg"="image/svg+xml"; ".ico"="image/x-icon";
           ".woff2"="font/woff2"; ".map"="application/json";
           # Pages sends this; the dev server was sending application/octet-stream, which
           # Chrome happens to parse anyway. A manifest that only works because the browser
           # is forgiving is a difference between dev and production waiting to matter.
           ".webmanifest"="application/manifest+json" }

$listener = $null
$ports = if ($Port -gt 0) { @($Port) } else { 8401..8410 }
foreach ($p in $ports) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l
    break
  } catch { }
}
if (-not $listener) {
  Write-Host "Could not find a free port ($($ports -join ', '))."
  if (-not $NoBrowser) { Read-Host "Press Enter to close" }
  exit 1
}

$url = $listener.Prefixes | Select-Object -First 1
Write-Host ""
Write-Host "  CONTAINMENT DETAIL is running at $url" -ForegroundColor Green
Write-Host "  Keep this window open while you play. Close it to stop." -ForegroundColor DarkGray
Write-Host ""
if (-not $NoBrowser) { Start-Process $url }

while ($listener.IsListening) {
  try {
    $ctx  = $listener.GetContext()
    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($path -eq '') { $path = 'index.html' }

    # ⚠ ONE WRITE ENDPOINT, FOR INSTRUMENTS THAT OUTLIVE THE LOAD EVENT.
    #
    # `--dump-dom` fires when the page settles, so anything still running loses its output —
    # which is what `--virtual-time-budget` was papering over, by making the dump wait. That
    # trade is unavailable to a BENCHMARK: under virtual time neither `Date.now()` nor
    # `performance.now()` advances during a synchronous task, measured here at 200,000,000
    # spins across 0 ms on both clocks, so every span a benchmark could time reads zero.
    #
    # So a long instrument runs in real time with no dump at all and POSTs its text here;
    # the runner polls for the file and then stops the browser. The name is fixed and the
    # body is written verbatim: no path comes from the request, so this cannot be made to
    # write anywhere else. It is a localhost dev server for a single-player browser game and
    # this is the only route by which a page may write to disk.
    if ($ctx.Request.HttpMethod -eq 'POST' -and $path -eq '__result') {
      # ⚠ UTF-8, STATED, NOT `$ctx.Request.ContentEncoding`. `sendBeacon` sends
      # `text/plain;charset=UTF-8` and HttpListener still handed back a codepage that turned
      # every em-dash in the report into `?"`. Both ends here are ours and both are UTF-8;
      # getting one of them right is how you produce mojibake rather than avoid it.
      $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd()
      $reader.Close()
      $slot = $ctx.Request.QueryString['slot']
      if ($slot -notmatch '^[0-9]{1,6}$') { $slot = '0' }
      [System.IO.File]::WriteAllText((Join-Path $root "_result-$slot.txt"), $body,
        (New-Object System.Text.UTF8Encoding $false))
      $ctx.Response.StatusCode = 204
      $ctx.Response.Close()
      continue
    }
    $file = Join-Path $root $path
    if ((Test-Path $file -PathType Leaf) -and ((Resolve-Path $file).Path.StartsWith($root))) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $ctx.Response.ContentType = if ($mime[$ext]) { $mime[$ext] } else { "application/octet-stream" }
      # no-store: a cached module during a test run is a false green
      $ctx.Response.Headers.Add("Cache-Control", "no-store")
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
  } catch { }
}

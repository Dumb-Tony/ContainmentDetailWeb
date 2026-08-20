# Is the live page serving THIS commit?
#
# Push is the deploy for this repo, so there is no build to compare — the question is only
# whether GitHub Pages has caught up. It takes up to a few minutes and it does not tell you
# honestly when it has: the pages/builds/latest API describes the PREVIOUS build for a while
# after a push, and it also goes stale on a deploy that already worked. What the URL actually
# returns is the only truth, so this polls the URL.
#
# ⚠ COMPARE GIT BLOB HASHES, NOT BYTE COUNTS. The working copy is CRLF and Pages serves LF,
# so a byte comparison is off by one per line and never matches, for every file, forever.
# A git blob hash is sha1("blob <len>`0" + LF content), which is exactly what `git rev-parse
# HEAD:<path>` prints — so the two are comparable without normalising anything by hand.
#
#   powershell -ExecutionPolicy Bypass -File tools/verify-live.ps1
#   powershell -ExecutionPolicy Bypass -File tools/verify-live.ps1 -Paths src/ui/base.js
param(
  [string]   $BaseUrl = 'https://dumb-tony.github.io/ContainmentDetailWeb',
  [string[]] $Paths   = @(),
  [int]      $TimeoutSeconds = 300,
  [int]      $IntervalSeconds = 15
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# Default to every file the commit touched. That is the set that can be stale, and checking
# one file and declaring the deploy good is how a half-served build gets posted as a link.
if (-not $Paths -or $Paths.Count -eq 0) {
  $Paths = @(git diff-tree --no-commit-id --name-only -r HEAD) |
           Where-Object { $_ -and (Test-Path $_) -and $_ -notmatch '^(docs/|tools/|GAME_BIBLE/|README\.md$)' }
}
if ($Paths.Count -eq 0) { Write-Host 'Nothing servable changed in HEAD.'; exit 0 }

$sha1 = [System.Security.Cryptography.SHA1]::Create()
function Get-BlobHash([byte[]] $bytes) {
  $prefix = [System.Text.Encoding]::ASCII.GetBytes("blob $($bytes.Length)`0")
  $buf = New-Object byte[] ($prefix.Length + $bytes.Length)
  [Array]::Copy($prefix, 0, $buf, 0, $prefix.Length)
  [Array]::Copy($bytes, 0, $buf, $prefix.Length, $bytes.Length)
  ($sha1.ComputeHash($buf) | ForEach-Object { $_.ToString('x2') }) -join ''
}

$want = @{}
foreach ($p in $Paths) { $want[$p] = (git rev-parse "HEAD:$p").Trim() }
$commit = (git rev-parse --short HEAD).Trim()
Write-Host "Verifying $($Paths.Count) file(s) against commit $commit at $BaseUrl"

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$try = 0
while ($true) {
  $try++
  $stale = @()
  foreach ($p in $Paths) {
    # Cache-bust: Pages serves max-age=600, so a plain fetch can return the old module for
    # ten minutes after the deploy is genuinely finished and report a false negative.
    $url = "$BaseUrl/$p" + '?v=' + [Guid]::NewGuid().ToString('N')
    try {
      # ⚠ WebClient.DownloadData, not Invoke-WebRequest. In PS 5.1 `$r.Content` is a decoded
      # String for any text response, so hashing it hashes the wrong thing — and because the
      # conversion throws, the failure surfaced as an empty "HTTP " status rather than as
      # itself. Every file on this site is text; all of them would have lied.
      $wc = New-Object System.Net.WebClient
      $wc.Headers.Add('Cache-Control', 'no-cache')
      $bytes = $wc.DownloadData($url)
      $got = Get-BlobHash $bytes
      if ($got -ne $want[$p]) { $stale += "$p (serving $($got.Substring(0,8)), want $($want[$p].Substring(0,8)))" }
    } catch {
      $stale += "$p ($($_.Exception.Message))"
    } finally {
      if ($wc) { $wc.Dispose(); $wc = $null }
    }
  }
  if ($stale.Count -eq 0) {
    Write-Host "MATCH on try $try - $BaseUrl is serving commit $commit" -ForegroundColor Green
    exit 0
  }
  if ((Get-Date) -ge $deadline) {
    Write-Host "TIMEOUT after $try tries. Still stale:" -ForegroundColor Red
    $stale | ForEach-Object { Write-Host "  $_" }
    exit 1
  }
  Write-Host "try ${try}: $($stale.Count) of $($Paths.Count) still stale, waiting ${IntervalSeconds}s"
  Start-Sleep -Seconds $IntervalSeconds
}

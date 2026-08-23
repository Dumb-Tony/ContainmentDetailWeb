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

# ⚠ A BLOB MATCH IS NOT A DEPLOY VERIFICATION ON ITS OWN, and believing it was is how the
# live site ran for eight commits telling every crash report it was `0e4a0aa`. This script
# compared the served bytes of the files HEAD touched, found them identical, printed MATCH
# in green, and never once asked the page what build it thought it was. index.html had not
# been restamped, so it was not in the changed-file set, so it was not checked — the one
# file whose staleness is invisible is the one that carries the build id.
#
# So the served page's own `cd-build` is read back and held to the only claim it makes:
# the code it names must be the code being served. Not "the stamp is recent" and not "the
# stamp is HEAD" — the stamp legitimately names the commit BEFORE the stamping commit
# (see stamp-build.ps1), and a fixup commit that touches nothing servable moves HEAD past
# it again. Both are fine and both would fail a hash-equality check on the sha.
#
# What cannot be fine is a stamped commit whose SOURCE differs from what is on the wire.
# index.html is excluded from that comparison and only from it: the stamp line is the one
# byte-difference the stamping commit is allowed to introduce.
function Test-ServedStamp([string] $baseUrl, [string[]] $paths) {
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('Cache-Control', 'no-cache')
  try {
    $url = "$baseUrl/index.html" + '?v=' + [Guid]::NewGuid().ToString('N')
    $html = [System.Text.Encoding]::UTF8.GetString($wc.DownloadData($url))
  } finally { $wc.Dispose() }

  $m = [regex]::Match($html, '<meta name="cd-build" content="([0-9a-f]+)[^"]*">')
  if (-not $m.Success) {
    Write-Host 'STAMP: the served index.html carries no cd-build meta.' -ForegroundColor Red
    Write-Host '       Every crash report from this build will name the deploy time, which identifies nothing.'
    return $false
  }
  $stamped = $m.Groups[1].Value

  # `2>$null` and not `2>&1`: redirecting a native command's stderr in PS 5.1 wraps each
  # line in an ErrorRecord and sets $? false on exit 0, which would report every healthy
  # deploy as an unknown commit.
  git rev-parse --verify --quiet "$stamped^{commit}" 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "STAMP: the served page names commit $stamped, which is not in this clone." -ForegroundColor Red
    Write-Host '       Either it was never pushed, or the live site is not this repository.'
    return $false
  }

  # ⚠ EVERY SERVED FILE, not just the ones HEAD happened to touch. "Does the stamp name the
  # code on the wire" is a question about the whole build. Scoped to the changed set it
  # would have answered "yes" for the entire eight-commit drift, because the commit that
  # exposed the problem touched content and the stamp had gone stale over src.
  $drift = @(git diff --name-only "$stamped" HEAD) |
           Where-Object { $_ -and $_ -notmatch '^(docs/|tools/|GAME_BIBLE/)' -and $_ -notmatch '/LICENSE$' -and
                          $_ -notin @('README.md', 'index.html', 'assets/lib/NOTICE.md', 'content/provenance.json') }
  if ($drift.Count -gt 0) {
    Write-Host "STAMP IS STALE: the served page says $stamped, but $($drift.Count) served file(s) have changed since:" -ForegroundColor Red
    $drift | Select-Object -First 8 | ForEach-Object { Write-Host "  $_" }
    if ($drift.Count -gt 8) { Write-Host "  ... and $($drift.Count - 8) more" }
    Write-Host '       Run tools/stamp-build.ps1, commit, and push before posting this link.'
    return $false
  }
  Write-Host "STAMP: served page names $stamped and every served file matches it." -ForegroundColor Green
  return $true
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
    Write-Host "Bytes match on try $try - $BaseUrl is serving commit $commit"
    if (Test-ServedStamp $BaseUrl $Paths) {
      Write-Host "MATCH - $BaseUrl is serving commit $commit and says so" -ForegroundColor Green
      exit 0
    }
    exit 1
  }
  if ((Get-Date) -ge $deadline) {
    Write-Host "TIMEOUT after $try tries. Still stale:" -ForegroundColor Red
    $stale | ForEach-Object { Write-Host "  $_" }
    exit 1
  }
  Write-Host "try ${try}: $($stale.Count) of $($Paths.Count) still stale, waiting ${IntervalSeconds}s"
  Start-Sleep -Seconds $IntervalSeconds
}

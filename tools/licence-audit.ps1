# Containment Detail - the attribution and licence audit.
#
# GDD 23 Milestone 6 gates on "complete attribution and license audit" and 25.8 states the
# licensing gate an Incident Package must pass before content lock. Neither is a thing you
# can hold in your head, and neither is a thing a browser test can reach: section K of
# tools\m0-tests.js checks the network rule over the module graph the page loads, which by
# construction excludes every file no ES module imports - assets\lib\**, content\**, and
# index.html itself. This walks the TREE.
#
# It answers four questions from the repository rather than from memory:
#
#   A  every third-party file, its licence, version and byte size, against what
#      assets\lib\NOTICE.md claims - and its SHA-256, which is the only check that catches
#      a vendored library edited in place
#   B  every shipped file that names a network host, against the two that are allowed
#   C  every content file's licensingRecordId, and whether it says why when it is null
#   D  every designation, and whether anything claims one it has not earned
#   E  anything in the tree with no provenance at all
#
# It exits 0 when the audit passes, 1 when it fails, and 2 when it could not run. Failures
# are printed with the file and the reason. -Strict promotes warnings to failures.
#
#   powershell -ExecutionPolicy Bypass -File tools\licence-audit.ps1
#   powershell -ExecutionPolicy Bypass -File tools\licence-audit.ps1 -Strict
#   powershell -ExecutionPolicy Bypass -File tools\licence-audit.ps1 -Quiet
#
# WHO CAN RUN THIS: anybody with PowerShell and a checkout. No Node, no browser, no network,
# no build step. That is deliberate - an audit that needs the person who wrote it is not an
# audit.
#
# NOTE ON POWERSHELL 5.1: nothing here redirects a native command's stderr with 2>&1. In
# 5.1 that wraps every stderr line in an ErrorRecord and sets $? to false on exit code 0.
# tools\run-tests.ps1 carries the same warning and the same scar.
param(
  [switch]$Strict,
  [switch]$Quiet,
  [string]$Root = ""
)
$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = Split-Path $PSScriptRoot -Parent }
if (-not (Test-Path $Root)) { Write-Host "No such root: $Root" -ForegroundColor Red; exit 2 }

$script:Fails = @()
$script:Warns = @()
$script:Notes = @()

function Fail($section, $what, $why) { $script:Fails += [pscustomobject]@{ S = $section; What = $what; Why = $why } }
function Warn($section, $what, $why) { $script:Warns += [pscustomobject]@{ S = $section; What = $what; Why = $why } }
function Say($text, $colour = "Gray") { if (-not $Quiet) { Write-Host $text -ForegroundColor $colour } }
function Head($text) { Say ""; Say "--- $text" "Cyan" }

# Everything the browser is served. docs\ is screenshots for the README and tools\ never
# ships, so neither is "shipped" - but both are still swept by section E, because a file
# nobody can account for is a finding wherever it lives.
$ShippedDirs = @("src", "content", "assets")
$ShippedRootFiles = @("index.html")

function RelPath($fullName) { $fullName.Substring($Root.Length + 1) -replace '\\', '/' }

function AllFiles {
  Get-ChildItem $Root -Recurse -File -Force |
    Where-Object { $_.FullName -notmatch '\\\.git\\' } |
    Where-Object { $_.Name -notlike '_*' }          # .gitignore excludes agent scratch
}

# ==========================================================================================
# A. the vendored third-party inventory
# ==========================================================================================
Head "A. third-party files, against what NOTICE.md claims"

$noticePath = Join-Path $Root "assets\lib\NOTICE.md"
if (-not (Test-Path $noticePath)) {
  Fail "A" "assets/lib/NOTICE.md" "missing - there is no attribution page at all"
  $claims = @{}
} else {
  $noticeText = Get-Content $noticePath -Raw -Encoding UTF8
  # The machine-readable block. Prose ages and nobody diffs it; this is parsed.
  $block = [regex]::Match($noticeText, '(?s)```audit\s*(.*?)```')
  $claims = @{}
  if (-not $block.Success) {
    Fail "A" "assets/lib/NOTICE.md" "has no ``````audit block - nothing in it can be checked"
  } else {
    foreach ($row in ($block.Groups[1].Value -split "`n")) {
      $t = $row.Trim()
      if (-not $t) { continue }
      $c = $t -split '\s*\|\s*'
      if ($c.Count -lt 7) { Fail "A" "NOTICE.md row" "expected 7 pipe-separated columns (path|licence|version|bytes|sha256|modified|copyright), got $($c.Count): $t"; continue }
      $claims[$c[0]] = [pscustomobject]@{
        Path = $c[0]; Licence = $c[1]; Version = $c[2]
        Bytes = [int64]$c[3]; Sha = $c[4].ToLower(); Modified = $c[5]; Copyright = $c[6]
      }
    }
  }
}

$libDir = Join-Path $Root "assets\lib"
$onDisk = @{}
if (Test-Path $libDir) {
  foreach ($f in (Get-ChildItem $libDir -Recurse -File)) {
    if ($f.Name -eq "NOTICE.md") { continue }
    # A LICENSE is not a vendored artefact, it is the NOTICE for the artefact beside it, and
    # it is checked in A2 below rather than expected to have a row of its own.
    if ($f.Name -eq "LICENSE") { continue }
    $rel = ($f.FullName.Substring($libDir.Length + 1)) -replace '\\', '/'
    $onDisk[$rel] = $f
  }
}

foreach ($rel in ($onDisk.Keys | Sort-Object)) {
  $f = $onDisk[$rel]
  $sha = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
  if (-not $claims.ContainsKey($rel)) {
    Fail "A" $rel "is vendored but NOTICE.md does not declare it - licence, version and origin all unknown"
    Say ("  {0,-34} {1,9:N0} bytes  {2}  UNDECLARED" -f $rel, $f.Length, $sha.Substring(0, 16)) "Red"
    continue
  }
  $c = $claims[$rel]
  $ok = $true
  if ($f.Length -ne $c.Bytes) { Fail "A" $rel "is $($f.Length) bytes; NOTICE.md claims $($c.Bytes)"; $ok = $false }
  if ($sha -ne $c.Sha) { Fail "A" $rel "SHA-256 is $sha; NOTICE.md claims $($c.Sha) - the file has been changed since it was recorded"; $ok = $false }
  if (-not $c.Licence) { Fail "A" $rel "NOTICE.md names no licence"; $ok = $false }
  # The version string has to be IN the file. A directory called r128 proves nothing.
  $text = Get-Content $f.FullName -Raw -Encoding UTF8
  if ($text -notmatch [regex]::Escape('"' + $c.Version + '"')) {
    Fail "A" $rel "does not contain the version string `"$($c.Version)`" that NOTICE.md claims"
    $ok = $false
  }
  $mark = if ($ok) { "ok" } else { "FAILED" }
  $colour = if ($ok) { "DarkGray" } else { "Red" }
  Say ("  {0,-34} {1,-4} {2,-7} {3,9:N0} bytes  {4}...  {5}" -f $rel, $c.Licence, ("v" + $c.Version), $f.Length, $sha.Substring(0, 12), $mark) $colour
}
foreach ($rel in ($claims.Keys | Sort-Object)) {
  if (-not $onDisk.ContainsKey($rel)) { Fail "A" $rel "is declared in NOTICE.md and is not in the tree" }
}

# ------------------------------------------------------------------------------------------
# A2. MIT REQUIRES THE NOTICE TO TRAVEL WITH THE CODE.
#
# A table in NOTICE.md records a claim; it does not accompany anything. MIT's own text says
# the copyright notice and the permission notice "shall be included in all copies or
# substantial portions of the Software", and what this project distributes is the .js file.
# So each library directory carries its own LICENSE, and this checks that it is there, that
# it really is the MIT text and not a stub, and that the copyright column agrees with it.
#
# ⚠ THE COPYRIGHT COLUMN IS CHECKED IN BOTH DIRECTIONS, and that is the entire point of it.
# An attribution audit that fabricates an attribution is worse than one that reports a gap:
# a gap is a known unknown that somebody can close, and a fabrication is a false statement
# with a green tick beside it. So:
#
#   a recorded line          must appear VERBATIM in the library AND in the LICENSE. A
#                            copyright line the software itself does not carry is one
#                            somebody typed, and it fails here.
#   'none-in-vendored-file'  must be TRUE - the library is re-measured for the string
#                            "copyright" and a nonzero count fails. The gap is then printed
#                            on every run, in yellow, with what it would take to close it.
#
# The second branch is not a failure, because it is not untrue: peerjs.min.js genuinely
# carries no copyright notice, and closing that needs the upstream release artefact - a
# network fetch, which is the one thing this audit is built not to require. It is a standing
# finding in docs/licensing-audit.md, printed here so it cannot go quiet.
$MIT_GRANT   = 'Permission is hereby granted, free of charge, to any person obtaining a copy'
$MIT_INCLUDE = 'The above copyright notice and this permission notice shall be included in all'
$MIT_ASIS    = 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'
$NoCopyright = 'none-in-vendored-file'
$licenceGaps = 0

foreach ($rel in ($claims.Keys | Sort-Object)) {
  $c = $claims[$rel]
  # Declared but not in the tree: already failed above, and there is no library here to read
  # a copyright line out of. Skipping keeps the failure to one line instead of two.
  if (-not $onDisk.ContainsKey($rel)) { continue }
  $dir = if ($rel -match '/') { $rel.Substring(0, $rel.LastIndexOf('/')) } else { '' }
  $licRel = if ($dir) { "$dir/LICENSE" } else { "LICENSE" }
  $licFull = Join-Path $libDir ($licRel -replace '/', '\')

  if (-not (Test-Path $licFull)) {
    Fail "A" "assets/lib/$licRel" "is missing - $rel is $($c.Licence), and MIT requires the copyright and permission notice to accompany the software. A row in NOTICE.md is a record of the licence, not a copy of it"
    Say ("  {0,-34} MISSING - the licence text does not travel with the code" -f $licRel) "Red"
    continue
  }

  $licText = Get-Content $licFull -Raw -Encoding UTF8
  $missing = @()
  foreach ($needle in @($MIT_GRANT, $MIT_INCLUDE, $MIT_ASIS)) {
    if (-not $licText.Contains($needle)) { $missing += ($needle.Substring(0, [Math]::Min(46, $needle.Length)) + "...") }
  }
  if ($missing.Count) {
    Fail "A" "assets/lib/$licRel" "exists but does not carry the MIT text it is supposed to be - missing: $($missing -join '  |  ')"
    Say ("  {0,-34} NOT THE MIT TEXT" -f $licRel) "Red"
    continue
  }

  $libText = Get-Content (Join-Path $libDir ($rel -replace '/', '\')) -Raw -Encoding UTF8
  $copyCount = ([regex]::Matches($libText, '(?i)copyright')).Count

  if ($c.Copyright -eq $NoCopyright) {
    if ($copyCount -gt 0) {
      Fail "A" $rel "NOTICE.md records the copyright as '$NoCopyright' and the file contains 'copyright' $copyCount time(s) - transcribe the real line into the copyright column and into assets/lib/$licRel"
    } else {
      $licenceGaps++
      Say ("  {0,-34} MIT text ok" -f $licRel) "DarkGray"
      Say ("  {0,-34} COPYRIGHT UNKNOWN, AND NOT INVENTED: the vendored file carries no copyright notice" -f "") "Yellow"
      # The byte length off disk, not $libText.Length - that is a character count, and the
      # two differ by however many multi-byte sequences the file holds.
      Say ("  {0,-34}   measured: 0 occurrences of 'copyright' in {1:N0} bytes of {2}" -f "", $onDisk[$rel].Length, $rel) "DarkYellow"
      Say ("  {0,-34}   to close: transcribe the copyright line from the upstream v{1} LICENSE into" -f "", $c.Version) "DarkYellow"
      Say ("  {0,-34}   NOTICE.md's copyright column and into assets/lib/{1}. See docs/licensing-audit.md." -f "", $licRel) "DarkYellow"
    }
  } elseif (-not $c.Copyright) {
    Fail "A" $rel "NOTICE.md's copyright column is empty - record the line the file carries, or the token '$NoCopyright' if it carries none. An empty column is indistinguishable from a column nobody filled in"
  } else {
    $inLib = $libText.Contains($c.Copyright)
    $inLic = $licText.Contains($c.Copyright)
    if (-not $inLib) {
      Fail "A" $rel "NOTICE.md claims the copyright line `"$($c.Copyright)`" and the vendored file does not contain it - an attribution the software itself does not carry is one somebody wrote"
    }
    if (-not $inLic) {
      Fail "A" "assets/lib/$licRel" "does not contain the copyright line `"$($c.Copyright)`" that NOTICE.md claims"
    }
    if ($inLib -and $inLic) {
      Say ("  {0,-34} MIT text ok, copyright verbatim in both the library and the notice" -f $licRel) "DarkGray"
      Say ("  {0,-34}   {1}" -f "", $c.Copyright) "DarkGray"
    }
  }
}

$script:Notes += "third-party files: $($onDisk.Count) on disk, $($claims.Count) declared, $($claims.Count - $licenceGaps) with a verified copyright line, $licenceGaps recorded as UNKNOWN"

# ==========================================================================================
# B. what reaches the network
# ==========================================================================================
Head "B. every shipped file that names a network host"

# The two that are allowed, and why each one is.
$AllowedHosts = @{
  "src/net/net.js"                        = "the PeerJS signalling broker (0.peerjs.com), which introduces two browsers and carries no game state"
  "assets/lib/peerjs-1.5.4/peerjs.min.js" = "the vendored library that dials that broker"
  # ⚠ A LICENCE NOTICE IS NOT A NETWORK REACH, and the exemption is by name for the same
  # reason the XML namespaces below are: widening the pattern until a false positive stops
  # matching is how the next true positive gets through the same hole. This file quotes the
  # homepage and repository the PeerJS bundle declares about ITSELF in its embedded package
  # metadata, as the evidence for what the licence is. It is plain text with no extension,
  # index.html does not reference it, nothing parses it and nothing fetches it.
  "assets/lib/peerjs-1.5.4/LICENSE"       = "the vendored library's MIT notice, quoting the homepage and repository the bundle declares in its own package metadata - text, not an endpoint"
}

# The same shape as m0-tests.js section K6: strip comments FIRST. Every rule here is about
# what the code DOES, and a raw grep tests what the file SAYS - rng.js explains at length
# that nothing may call Math.random and would fail its own check for containing the
# sentence. crash.js explains that it does not phone home and names a github.io URL in the
# comment that says so.
function StripComments($text, $ext) {
  if ($ext -eq ".js" -or $ext -eq ".html") {
    $t = [regex]::Replace($text, '(?s)/\*.*?\*/', '')
    $t = [regex]::Replace($t, '(?m)(^|[^:])//.*$', '$1')
    $t = [regex]::Replace($t, '(?s)<!--.*?-->', '')
    return $t
  }
  return $text
}

$HostPattern = 'https?://|[a-z0-9-]+\.(?:com|net|io|org|dev|app|gg)[''"/]|wss?://'

# A NAMESPACE URI IS NOT AN ENDPOINT, and treating it as one is how a check like this gets
# turned off. Measured: assets/lib/r128/three.min.js contains exactly one distinct host,
# www.w3.org, in four occurrences of
#
#     document.createElementNS("http://www.w3.org/1999/xhtml","canvas")
#
# which is the XHTML namespace identifier. It is a name, not an address; nothing dereferences
# it and no request is ever made. Failing the audit on it would be wrong, and quietly
# widening the pattern until it stopped matching would be worse - the next real host would
# slip through the same hole. So the exact namespace strings are subtracted, by name, and the
# count of them is printed on every run so that the exemption stays visible.
$NamespaceUris = @(
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace'
)
function StripNamespaces($text) {
  $t = $text
  foreach ($ns in $NamespaceUris) { $t = $t.Replace($ns, '(xml-namespace)') }
  # w3.org can only appear inside one of the four above; once they are gone, any left is real.
  return $t
}

# ⚠ A HOST INSIDE A CONTENT-SECURITY-POLICY IS THE OPPOSITE OF A REACH.
#
# Same argument as the namespace stripper above, and it needs making because check B is
# otherwise exactly right and exactly wrong here: `index.html` names `0.peerjs.com` twice,
# and it names it in a `connect-src` ALLOW-LIST — a sentence saying which host the page may
# talk to, which is a restriction and not a connection. Left unstripped, adding a CSP fails
# the audit that exists to notice new network reaches, and the lesson a reader draws is
# "don't add a CSP".
#
# The count is reported rather than swallowed, so a policy that grows a host still shows up
# on the run: a CSP is a place a host can be smuggled in, it is simply not a place one can
# be reached from.
function StripCsp($text) {
  $t = [regex]::Replace($text,
    '(?is)<meta\s+http-equiv\s*=\s*"Content-Security-Policy"[^>]*>', '(csp-allowlist)')
  # The unfurl tags are the second legitimate place a URL lives without being a reach:
  # og:url / og:image / twitter:image are addresses FOR this page, required absolute by the
  # OpenGraph spec, and they may name exactly one host — the canonical deploy origin. The
  # pattern binds the property name AND the origin, so a scraper tag pointing anywhere else
  # is still a finding.
  return [regex]::Replace($t,
    '(?is)<meta\s+(?:property|name)\s*=\s*"(?:og:url|og:image|twitter:image)"\s+content\s*=\s*"https://dumb-tony\.github\.io/[^"]*">', '(unfurl-address)')
}
$shipped = @()
foreach ($d in $ShippedDirs) {
  $p = Join-Path $Root $d
  if (Test-Path $p) { $shipped += Get-ChildItem $p -Recurse -File | Where-Object { $_.Name -notlike '_*' } }
}
foreach ($n in $ShippedRootFiles) {
  $p = Join-Path $Root $n
  if (Test-Path $p) { $shipped += Get-Item $p }
}

$reaching = @()
foreach ($f in $shipped) {
  if ($f.Extension -in @(".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp3", ".ogg", ".wav", ".woff", ".woff2", ".ttf")) { continue }
  $rel = RelPath $f.FullName
  $rawBody = StripComments (Get-Content $f.FullName -Raw -Encoding UTF8) $f.Extension
  $before = ([regex]::Matches($rawBody, $HostPattern, 'IgnoreCase')).Count
  $cspStripped = StripCsp $rawBody
  $cspCount = $before - ([regex]::Matches($cspStripped, $HostPattern, 'IgnoreCase')).Count
  $body = StripNamespaces $cspStripped
  $m = [regex]::Matches($body, $HostPattern, 'IgnoreCase')
  $nsCount = $before - $cspCount - $m.Count
  if ($cspCount -gt 0) { Say ("  {0,-42} {1} host(s) in a CSP allow-list, no endpoint" -f $rel, $cspCount) "DarkGray" }
  if ($m.Count -eq 0) {
    if ($nsCount -gt 0) { Say ("  {0,-42} {1} XML namespace URI(s), no endpoint" -f $rel, $nsCount) "DarkGray" }
    continue
  }
  $sample = ($m | Select-Object -First 3 | ForEach-Object { $_.Value }) -join ', '
  $reaching += $rel
  if ($AllowedHosts.ContainsKey($rel)) {
    Say ("  {0,-42} {1} match(es)  allowed: {2}" -f $rel, $m.Count, $AllowedHosts[$rel]) "DarkGray"
  } else {
    Fail "B" $rel "names a network host and is not one of the two that may ($sample)"
    Say ("  {0,-42} {1} match(es)  NOT ALLOWED: {2}" -f $rel, $m.Count, $sample) "Red"
  }
}
foreach ($rel in $AllowedHosts.Keys) {
  if ($reaching -notcontains $rel) {
    Warn "B" $rel "is on the allow-list but no longer names a host - the exception may be stale"
  }
}
$script:Notes += "shipped files naming a host: $($reaching.Count) (allowed: $($AllowedHosts.Count))"

# The broker must stay signalling-only. Same claim as K7, checked here over the raw file so
# a future refactor that moves PEER_OPTS cannot make the check silently vacuous.
$netPath = Join-Path $Root "src\net\net.js"
if (Test-Path $netPath) {
  $netBody = StripComments (Get-Content $netPath -Raw -Encoding UTF8) ".js"
  if ($netBody -notmatch 'PEER_OPTS') {
    Warn "B" "src/net/net.js" "no longer defines PEER_OPTS - K7's 'no game state near the broker' check may no longer be testing anything"
  } elseif ($netBody -match '(?s)PEER_OPTS.{0,400}(encodeSnapshot|snapshot|game\.)') {
    Fail "B" "src/net/net.js" "game state appears within 400 characters of the broker options"
  }
}

# ==========================================================================================
# C. content provenance
# ==========================================================================================
Head "C. every content file's licensingRecordId"

# GDD 25.3: every SCP-derived content item must have a record BEFORE implementation. A file
# is accounted for if it either carries a non-null licensingRecordId, or carries null AND
# says why in _licensingNote. Null with no note is the one shape that means nothing at all -
# it is indistinguishable from a field somebody forgot.
#
# TWO TIERS, and the difference between them is the difference between "this is wrong" and
# "this is not finished".
#
#   default  fails only on what is internally inconsistent or verifiably untrue: a hash that
#            has moved, an unauthorised host, a designation claiming more than it has earned,
#            an anomaly carrying a bare null where its four siblings carry an explanation.
#            An audit that cries wolf on the first run is an audit somebody adds to the
#            ignore list.
#   -Strict  is the 25.8 CONTENT-LOCK GATE: every content file declares its provenance and
#            every media asset has a record. That is the bar Milestone 6 has to clear, and
#            it is not cleared today - see docs\licensing-audit.md.
#
# The anomaly is the only content here that could plausibly be derived from an article, so
# it is the one required at both tiers.
$RequiredDirs = @("content/anomalies")

# THE THIRD WAY A FILE CAN BE ACCOUNTED FOR. content/locales/** is owned and regenerated by
# the internationalisation work, and a declaration inserted into a generated file survives
# until the next generation and then silently does not - which is this audit's own failure
# mode arriving through the front door. So content/provenance.json covers those from
# OUTSIDE, where the coverage cannot be regenerated away, and section F checks that every
# entry in it still names a real file that still has no inline declaration of its own.
$manifestRel = "content/provenance.json"
$manifestPath = Join-Path $Root "content\provenance.json"
$script:Manifest = $null
$coverage = @{}
if (Test-Path $manifestPath) {
  $mraw = Get-Content $manifestPath -Raw -Encoding UTF8
  try { $script:Manifest = $mraw | ConvertFrom-Json } catch { Fail "C" $manifestRel "is not valid JSON: $($_.Exception.Message)" }
  if ($script:Manifest) {
    foreach ($e in @($script:Manifest.coverage)) { if ($e -and $e.path) { $coverage[[string]$e.path] = $e } }
  }
} else {
  Fail "C" $manifestRel "is missing - it is the coverage list for content files that cannot carry a declaration inline, and GDD 25.3's attribution database, and without it neither exists anywhere in the repository"
}

$contentDir = Join-Path $Root "content"
$declared = 0; $noted = 0; $covered = 0; $bare = 0
$script:RecordIds = @()
if (Test-Path $contentDir) {
  foreach ($f in (Get-ChildItem $contentDir -Recurse -File -Filter *.json | Sort-Object FullName)) {
    $rel = RelPath $f.FullName
    $raw = Get-Content $f.FullName -Raw -Encoding UTF8
    try { $doc = $raw | ConvertFrom-Json } catch { Fail "C" $rel "is not valid JSON: $($_.Exception.Message)"; continue }
    $hasKey = $doc.PSObject.Properties.Name -contains 'licensingRecordId'
    $note = if ($doc.PSObject.Properties.Name -contains '_licensingNote') { [string]$doc._licensingNote } else { "" }
    $required = $false
    foreach ($d in $RequiredDirs) { if ($rel.StartsWith($d + "/")) { $required = $true } }

    if ($hasKey -and $null -ne $doc.licensingRecordId) {
      $declared++
      $script:RecordIds += [pscustomobject]@{ File = $rel; Id = [string]$doc.licensingRecordId }
      Say ("  {0,-46} record {1}" -f $rel, $doc.licensingRecordId) "DarkGray"
    } elseif ($hasKey -and $note) {
      $noted++
      Say ("  {0,-46} null, and says why" -f $rel) "DarkGray"
    } elseif ($coverage.ContainsKey($rel)) {
      $covered++
      Say ("  {0,-46} covered by {1} ({2})" -f $rel, $manifestRel, $coverage[$rel].reason) "DarkGray"
    } elseif ($hasKey) {
      $bare++
      $why = "declares licensingRecordId: null with no _licensingNote and no entry in $manifestRel - GDD 25.3 wants a record before implementation, and a bare null is indistinguishable from a field somebody forgot"
      if ($required) { Fail "C" $rel $why } else { Warn "C" $rel $why }
      Say ("  {0,-46} null, UNEXPLAINED" -f $rel) "Red"
    } else {
      $bare++
      $why = "has no licensingRecordId at all and no entry in $manifestRel - nothing states where its material came from"
      if ($required) { Fail "C" $rel $why } else { Warn "C" $rel $why }
      Say ("  {0,-46} no declaration" -f $rel) $(if ($required) { "Red" } else { "DarkYellow" })
    }
  }
}
$script:Notes += "content files: $declared with a record, $noted original-and-say-so, $covered covered by the manifest, $bare undeclared"

# ==========================================================================================
# D. designations
# ==========================================================================================
Head "D. designations, and whether anything claims one it has not earned"

# GDD 25.3: a final designation is assigned only after the licensing record exists. So a
# designation belonging to an item whose record is null must carry the word "provisional".
# And an SCP-### string anywhere in content is the moment this project starts making a
# licensing claim nobody has cleared - 25.6 singles out SCP-173 in particular.
$designations = 0
if (Test-Path $contentDir) {
  foreach ($f in (Get-ChildItem $contentDir -Recurse -File -Filter *.json | Sort-Object FullName)) {
    $rel = RelPath $f.FullName
    $raw = Get-Content $f.FullName -Raw -Encoding UTF8

    foreach ($m in [regex]::Matches($raw, '"designation"\s*:\s*"([^"]*)"')) {
      $d = $m.Groups[1].Value
      $designations++
      if ($d -match '(?i)provisional') {
        Say ("  {0,-40} {1}" -f $rel, $d) "DarkGray"
      } else {
        Fail "D" $rel "designation `"$d`" is not marked provisional, and no licensing record exists to justify a final one (GDD 25.3)"
        Say ("  {0,-40} {1}   NOT PROVISIONAL" -f $rel, $d) "Red"
      }
    }
    foreach ($m in [regex]::Matches($raw, '(?i)\bSCP[\s-]?\d{2,4}\b')) {
      Fail "D" $rel "contains `"$($m.Value)`" - an SCP designation, in a build whose every licensingRecordId is null (GDD 25.3, 25.6)"
    }
  }
}
$script:Notes += "designations found: $designations"

# The in-game notice. 25.4 requires attribution reachable from the main menu rather than
# buried in end credits. It is a real requirement and it is checkable: something in the
# base screen has to route to it.
$siteJson = Join-Path $Root "content\site.json"
if (Test-Path $siteJson) {
  $siteRaw = Get-Content $siteJson -Raw -Encoding UTF8
  if ($siteRaw -notmatch '(?i)attribution') {
    Fail "D" "content/site.json" "nothing in the site declares an attribution or licensing record for the player to read (GDD 25.4: it must be reachable, not buried in end credits)"
  } else {
    Say "  content/site.json                        names an attribution record the player can reach" "DarkGray"
  }
}

# ==========================================================================================
# E. anything with no provenance at all
# ==========================================================================================
Head "E. files with no provenance"

# Everything in the tree is either first-party (written here), declared third-party
# (NOTICE.md), or infrastructure (git plumbing, ignore files). Anything else is a file
# somebody dropped in, and 25.5 is explicit: reject assets with unknown provenance.
# ⚠ `assets/` IS DELIBERATELY NOT A FIRST-PARTY ROOT. It is where vendored things live, and
# a blanket over the whole directory would make section A's "declared in NOTICE.md" check
# unreachable — drop a library into assets/ and nothing would ask about it. So the two
# subtrees are named separately: assets/lib/ is handled above, against NOTICE.md, and
# assets/icons/ is this build's own generated art, itemised file by file in the media table
# in docs/licensing-audit.md, which is the check that actually accounts for each one.
$FirstPartyRoots = @("src/", "content/", "tools/", "docs/", "GAME_BIBLE/", "assets/icons/")
$FirstPartyFiles = @("index.html", "README.md", ".gitignore", ".gitattributes", ".nojekyll",
                     "manifest.webmanifest", "sw.js")
$unaccounted = 0
foreach ($f in (AllFiles)) {
  $rel = RelPath $f.FullName
  if ($rel -eq "assets/lib/NOTICE.md") { continue }
  if ($rel.StartsWith("assets/lib/")) {
    $sub = $rel.Substring("assets/lib/".Length)
    # A LICENSE is the notice for the library beside it, not a vendored artefact of its own.
    # A2 has already checked that it exists, that it is the MIT text, and that its copyright
    # line agrees with NOTICE.md and with the library, which is a stricter account than a row
    # in the table would have been.
    if ($sub -match '(^|/)LICENSE$') { continue }
    if (-not $claims.ContainsKey($sub)) { $unaccounted++ }   # already failed in A
    continue
  }
  $isFirst = $false
  foreach ($r in $FirstPartyRoots) { if ($rel.StartsWith($r)) { $isFirst = $true } }
  if ($FirstPartyFiles -contains $rel) { $isFirst = $true }
  if ($isFirst) { continue }
  $unaccounted++
  Fail "E" $rel "is in the tree and is neither first-party source nor a declared third-party file (GDD 25.5: reject assets with unknown provenance)"
}

# Binary media is the category 25.5 is actually about, so it is counted out loud even when
# it is first-party: every one of these needs its own provenance record, and "we made it"
# is a provenance record only if somebody wrote it down.
$media = AllFiles | Where-Object { $_.Extension -in @(".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp3", ".ogg", ".wav", ".woff", ".woff2", ".ttf", ".glb", ".fbx") }
$mediaRecord = Join-Path $Root "docs\licensing-audit.md"
if ($media.Count -gt 0) {
  $recorded = if (Test-Path $mediaRecord) { Get-Content $mediaRecord -Raw -Encoding UTF8 } else { "" }
  foreach ($m in $media) {
    $rel = RelPath $m.FullName
    if ($recorded -match [regex]::Escape($rel)) {
      Say ("  {0,-40} {1,9:N0} bytes  recorded" -f $rel, $m.Length) "DarkGray"
    } else {
      Warn "E" $rel "is a media file with no entry in docs/licensing-audit.md (GDD 25.5: track source, author, licence and modifications per asset)"
    }
  }
}
$script:Notes += "media files: $($media.Count); unaccounted files: $unaccounted"

# ==========================================================================================
# F. the provenance manifest, the 25.3 database, and the 25.8 gate
# ==========================================================================================
Head "F. content/provenance.json - coverage, the 25.3 database, and the 25.8 gate"

# 25.3 asks for a twelve-field record per SCP-derived item BEFORE implementation, and says
# credits should be generated from it. Until this file existed the table did not exist
# either, which is a different and worse thing than an empty table: an absent schema is what
# lets the first derived item ship with no record at all, because there is nothing for it to
# fail. Here the schema exists, has no rows, and the audit enforces the link in both
# directions - so the first non-null licensingRecordId anywhere in content/ fails this
# section until somebody fills in twelve fields.
$Fields25_3 = @(
  'designationAndArticleTitle', 'articleUrl', 'authorsAndAttributionSource', 'wikiBranch',
  'pageRevisionOrAccessDate', 'conceptsTextCharactersOrProceduresAdapted', 'changesMadeForTheGame',
  'requiredLicenceAndNotice', 'associatedAssetsAndTheirIndependentSources', 'internalContentOwner',
  'legalReviewStatus', 'inGameAndDistributionCreditLocation'
)
# 25.8, verbatim, seven clauses. The count is asserted because a gate that quietly lost a
# clause would still pass.
$GateClauses = 7
$GateStatuses = @('cleared', 'not-applicable', 'open')

if ($null -eq $script:Manifest) {
  Say "  no manifest to check - see the failure in section C" "Red"
} else {
  # ── coverage: every entry names a real file that still has no inline declaration ────────
  $covRows = @($script:Manifest.coverage)
  foreach ($e in $covRows) {
    $p = [string]$e.path
    if (-not $p) { Fail "F" $manifestRel "has a coverage entry with no path"; continue }
    $full = Join-Path $Root ($p -replace '/', '\')
    if (-not (Test-Path $full)) {
      Fail "F" $manifestRel "covers `"$p`", which is not in the tree - a coverage entry for a file that does not exist is a claim about nothing"
      continue
    }
    # ⚠ A STALE ENTRY IS THE FAILURE MODE OF A MANIFEST. If the file has since grown its own
    # declaration, two places now state its provenance and only one of them is next to the
    # material. They will disagree eventually, and the audit would be reading the wrong one.
    $tgt = Get-Content $full -Raw -Encoding UTF8
    if ($tgt -match '"licensingRecordId"') {
      Fail "F" $manifestRel "covers `"$p`", which now declares licensingRecordId inline - remove the coverage entry, because two statements of provenance in two places is one more than can be kept true"
      continue
    }
    if (-not $e.reason) { Fail "F" $manifestRel "covers `"$p`" with no reason - coverage from outside the file needs to say why the file cannot carry it" }
    if (-not $e.note)   { Fail "F" $manifestRel "covers `"$p`" with no note - a coverage entry with no statement of provenance accounts for nothing" }
    $hasId = $e.PSObject.Properties.Name -contains 'licensingRecordId'
    if (-not $hasId) { Fail "F" $manifestRel "covers `"$p`" without a licensingRecordId field - a missing field and a null one must stay distinguishable here too" }
    elseif ($null -ne $e.licensingRecordId) { $script:RecordIds += [pscustomobject]@{ File = $p; Id = [string]$e.licensingRecordId } }
    if ($e.reason -and $e.note -and $hasId) { Say ("  coverage  {0,-38} {1}" -f $p, $e.reason) "DarkGray" }
  }
  Say ("  coverage entries: {0}" -f $covRows.Count) "DarkGray"

  # ── 25.3's twelve fields ────────────────────────────────────────────────────────────────
  $db = $script:Manifest.attributionDatabase
  if ($null -eq $db) {
    Fail "F" $manifestRel "has no attributionDatabase - GDD 25.3 requires a record per SCP-derived item before implementation, and asks that credits be generated from it"
  } else {
    $fields = @($db.fields)
    $missingF = @($Fields25_3 | Where-Object { $fields -notcontains $_ })
    $extraF = @($fields | Where-Object { $Fields25_3 -notcontains $_ })
    if ($missingF.Count) { Fail "F" $manifestRel "attributionDatabase.fields is missing $($missingF.Count) of GDD 25.3's twelve required fields: $($missingF -join ', ')" }
    if ($extraF.Count) { Fail "F" $manifestRel "attributionDatabase.fields names $($extraF.Count) field(s) GDD 25.3 does not: $($extraF -join ', ')" }
    if (-not $missingF.Count -and -not $extraF.Count) {
      Say ("  attribution database: all {0} of GDD 25.3's required fields present, {1} row(s)" -f $fields.Count, @($db.records).Count) "DarkGray"
    }

    # every non-null record id in content must have a row here, and every row must be complete
    $rows = @{}
    foreach ($r in @($db.records)) {
      $rid = [string]$r.recordId
      if (-not $rid) { Fail "F" $manifestRel "attributionDatabase has a row with no recordId"; continue }
      $rows[$rid] = $r
      $blank = @($Fields25_3 | Where-Object { -not $r.$_ })
      if ($blank.Count) { Fail "F" $manifestRel "attributionDatabase row `"$rid`" leaves $($blank.Count) of the twelve required fields blank: $($blank -join ', ')" }
    }
    foreach ($u in $script:RecordIds) {
      if (-not $rows.ContainsKey($u.Id)) {
        Fail "F" $u.File "declares licensingRecordId `"$($u.Id)`" and there is no row for it in $manifestRel - GDD 25.3 makes the record a prerequisite for implementation, not a follow-up"
      }
    }
    if ($script:RecordIds.Count -eq 0) {
      Say "  no content file claims a licensing record, so the database is correctly empty" "DarkGray"
    }
  }

  # ── 25.8's gate ─────────────────────────────────────────────────────────────────────────
  $gate = $script:Manifest.gate
  if ($null -eq $gate) {
    Fail "F" $manifestRel "has no gate - GDD 25.8 lists seven clauses an Incident Package must clear before content lock, and this is where they are answered"
  } else {
    $clauses = @($gate.clauses)
    if ($clauses.Count -ne $GateClauses) {
      Fail "F" $manifestRel "gate.clauses has $($clauses.Count) entries; GDD 25.8 states $GateClauses. A gate that quietly lost a clause still passes, which is why the count is asserted"
    }
    $open = 0
    foreach ($cl in $clauses) {
      $st = [string]$cl.status
      if (-not $cl.clause) { Fail "F" $manifestRel "gate has a clause with no text"; continue }
      if ($GateStatuses -notcontains $st) {
        Fail "F" $manifestRel "gate clause `"$($cl.clause)`" has status `"$st`", which is not one of: $($GateStatuses -join ', ')"
        continue
      }
      if (-not $cl.recorded) {
        Fail "F" $manifestRel "gate clause `"$($cl.clause)`" is marked $st and records no reason - 25.8's last clause is that the status be RECORDED, and an unrecorded status clears nothing"
        continue
      }
      if ($st -eq 'open') {
        $open++
        Warn "F" $manifestRel "GDD 25.8 gate clause is OPEN: `"$($cl.clause)`" - $($cl.recorded)"
        Say ("  gate      {0,-38} OPEN" -f $cl.clause.Substring(0, [Math]::Min(38, $cl.clause.Length))) "DarkYellow"
      } else {
        Say ("  gate      {0,-52} {1}" -f $cl.clause.Substring(0, [Math]::Min(52, $cl.clause.Length)), $st) "DarkGray"
      }
    }
    $script:Notes += "GDD 25.8 gate: $($clauses.Count) clause(s), $open open"
  }
}

# ==========================================================================================
# the verdict
# ==========================================================================================
Say ""
Say "=== measured ===" "Cyan"
foreach ($n in $script:Notes) { Say "  $n" }

if ($Strict -and $script:Warns.Count) {
  foreach ($w in $script:Warns) { $script:Fails += $w }
  $script:Warns = @()
}

if ($script:Warns.Count) {
  Say ""
  Say "=== $($script:Warns.Count) warning(s) ===" "Yellow"
  foreach ($w in $script:Warns) { Write-Host ("  [{0}] {1}" -f $w.S, $w.What) -ForegroundColor Yellow; Write-Host ("        {0}" -f $w.Why) -ForegroundColor DarkYellow }
}

if ($script:Fails.Count) {
  Write-Host ""
  Write-Host "=== $($script:Fails.Count) failure(s) ===" -ForegroundColor Red
  foreach ($f in $script:Fails) { Write-Host ("  [{0}] {1}" -f $f.S, $f.What) -ForegroundColor Red; Write-Host ("        {0}" -f $f.Why) -ForegroundColor DarkGray }
  Write-Host ""
  Write-Host "LICENCE AUDIT FAILED  $($script:Fails.Count) failure(s), $($script:Warns.Count) warning(s)" -ForegroundColor Red
  exit 1
}

Write-Host ""
if ($script:Warns.Count -and -not $Strict) {
  Write-Host "LICENCE AUDIT PASSED  0 failures, $($script:Warns.Count) warning(s)" -ForegroundColor Green
  Write-Host "  Nothing is untrue. The warnings are the GDD 25.8 content-lock gate, which is not" -ForegroundColor DarkYellow
  Write-Host "  cleared yet - run with -Strict to see it as the failure it will be at Milestone 6." -ForegroundColor DarkYellow
  exit 0
}
Write-Host "LICENCE AUDIT PASSED  0 failures, 0 warnings" -ForegroundColor Green
exit 0

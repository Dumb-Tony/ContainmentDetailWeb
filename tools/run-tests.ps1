# Run every suite in tools\*-tests.js and report the total.
#
# ⚠ WHY SEPARATE FILES AND SEPARATE RUNS. `m0-tests.js` reached six thousand lines and 875
# assertions in one file, and four agents working at once all wanted to append a section to
# it. The splice conflicts cost more than the tests did, and two of them silently landed
# inside another agent's commit. A suite per topic removes the contention entirely.
#
# Each suite runs in its OWN browser, on its OWN port, against its OWN scratch page, so one
# suite cannot leave state behind for the next and a suite that hangs cannot take the others
# with it. That is slower than one page and it is the only version whose result means
# anything when several people are editing at once.
#
#   .\tools\run-tests.ps1                 every suite
#   .\tools\run-tests.ps1 -Only net       only tools\*net*-tests.js
#   .\tools\run-tests.ps1 -BasePort 8460  when 8411+ is busy
param(
  [string]$Only = "",
  [int]$BasePort = 8411,
  [switch]$FailFast
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$suites = Get-ChildItem (Join-Path $root "tools") -Filter "*-tests.js" | Sort-Object Name
if ($Only) { $suites = $suites | Where-Object { $_.Name -like "*$Only*" } }
if (-not $suites) { Write-Host "No suites matched." -ForegroundColor Red; exit 2 }

$totalPass = 0; $totalFail = 0; $rows = @()
$port = $BasePort
foreach ($s in $suites) {
  $rel = "tools\" + $s.Name
  Write-Host "--- $rel (port $port)" -ForegroundColor Cyan
  # ⚠ NO `2>&1` ON A NATIVE COMMAND. In PowerShell 5.1 redirecting a native process's stderr
  # wraps every line in an ErrorRecord and sets $? to false even on exit code 0, so the run
  # dies on Chrome's harmless "Missing value path for key ... Extensions" warning. stderr is
  # already surfaced by the child; take stdout and leave it alone.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = & powershell -ExecutionPolicy Bypass -File (Join-Path $root "tools\smoketest.ps1") -Tests $rel -Port $port
  $ErrorActionPreference = $prev
  $port++

  # The suite's own failure lines are the useful output; echo them and nothing else.
  $out | Where-Object { $_ -match '^FAIL' } | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }

  $pass = 0; $fail = 0
  $tail = ($out | Where-Object { $_ -match '^(ALL-PASS|FAILURES)' } | Select-Object -Last 1)
  if ($tail -match '^ALL-PASS\s+(\d+)') { $pass = [int]$Matches[1] }
  elseif ($tail -match '^FAILURES\s+(\d+) of (\d+)') { $fail = [int]$Matches[1]; $pass = [int]$Matches[2] - $fail }
  else {
    # No result block at all: the page crashed before the harness ran. That is a failure of
    # the whole suite and must not be reported as zero assertions and no problem.
    $banner = ($out | Where-Object { $_ -match 'Error banner|No test output' } | Select-Object -First 2) -join ' / '
    Write-Host "  NO RESULT: $banner" -ForegroundColor Red
    $fail = 1
  }
  $totalPass += $pass; $totalFail += $fail
  $rows += [pscustomobject]@{ Suite = $s.Name; Pass = $pass; Fail = $fail }
  if ($FailFast -and $fail -gt 0) { break }
}

Write-Host ""
$rows | Format-Table -AutoSize | Out-String | Write-Host
if ($totalFail -eq 0) {
  Write-Host "ALL-PASS  $totalPass assertions across $($rows.Count) suite(s)" -ForegroundColor Green
  exit 0
}
Write-Host "FAILURES  $totalFail of $($totalPass + $totalFail) across $($rows.Count) suite(s)" -ForegroundColor Red
exit 1

# Start OUR dev server and prove the port is serving OUR files.
#
# WHY THIS EXISTS
# ---------------
# Other projects on this machine run the same tooling — SmallTownEmergencyServices and
# TowBros were both copied from here — so they have identically named scratch files and
# they compete for the same ports. A readiness probe that only checks "did something
# answer on 8378 with a 200" WILL eventually attach to another project's server, and it
# fails silently: the run completes and produces a perfectly good screenshot or test
# result belonging to a different game. That happened, and the screenshot went into this
# repo before anyone noticed.
#
# So the caller stamps its scratch file with a GUID and this script refuses any port
# whose response does not contain that exact stamp.
#
# Dot-source it and call Start-MyServer.

function Start-MyServer {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ScratchName,   # e.g. _shot.html
    [Parameter(Mandatory = $true)][string]$Stamp,         # must appear in the served file
    [int[]]$Ports = @(8378, 8380, 8381, 8382, 8383, 8384, 8385)
  )

  foreach ($port in $Ports) {
    $proc = Start-Process powershell `
      -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","$Root\tools\serve.ps1","-NoBrowser","-Port","$port" `
      -WindowStyle Hidden -PassThru

    $url = "http://localhost:$port/$ScratchName"
    $ok = $false
    for ($i = 0; $i -lt 24; $i++) {
      Start-Sleep -Milliseconds 200
      try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) {
          # THE check. A 200 is not enough; it has to be our file.
          if ($r.Content -match [regex]::Escape($Stamp)) { $ok = $true }
          break
        }
      } catch { }
    }

    if ($ok) { return [pscustomobject]@{ Port = $port; Url = $url; Process = $proc } }

    # Either the bind failed (someone else has the port) or the answer came from another
    # project. Either way this port is unusable — stop ours if it is running and move on.
    if ($proc -and -not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force } catch { } }
    Write-Host "  port $port is not serving this project - trying the next" -ForegroundColor DarkYellow
  }

  return $null
}

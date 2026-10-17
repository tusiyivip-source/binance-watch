# ============================================================
#  binance-watch watchdog
#  - checks http://127.0.0.1:8860/api/stats every N seconds
#  - if the service is down (or not answering), starts server.js again
#  - logs to data/watchdog.log
#  - designed to be launched at logon (see Startup shortcut)
#  NOTE: keep this file ASCII-only so Windows PowerShell 5.1 reads it safely.
# ============================================================
param(
  [int]$Port = 8860,
  [int]$IntervalSec = 300,
  [int]$StartupWaitSec = 45
)

$ErrorActionPreference = 'SilentlyContinue'
# single-instance guard: only one watchdog may run at a time
$mutex = New-Object System.Threading.Mutex($false, 'Global\binance-watch-watchdog')
if (-not $mutex.WaitOne(0)) { return }

$root = Split-Path -Parent $PSScriptRoot          # tools\ -> project root
$nodeExe = 'K:\NODE软件\node.exe'
if (-not (Test-Path $nodeExe)) {
  try {
    $fso = New-Object -ComObject Scripting.FileSystemObject
    $nodeExe = Join-Path $fso.GetFolder('K:\').ShortPath 'NODE软件\node.exe'
  } catch { }
}
if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
$logDir = Join-Path $root 'data'
$logFile = Join-Path $logDir 'watchdog.log'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

function Write-Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Test-Healthy {
  try {
    $r = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/stats" -f $Port) -TimeoutSec 12
    if ($null -eq $r) { return $false }
    if ($null -eq $r.market) { return $false }
    return $true
  } catch {
    return $false
  }
}

function Get-AppProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like ('*' + $root + '*server.js*') -or $_.CommandLine -like '*binance-watch*server.js*' }
}

function Start-App {
  $p = Get-AppProcess
  if ($p) {
    Write-Log ('process exists but not healthy, pid=' + (($p | ForEach-Object { $_.ProcessId }) -join ','))
    return $false
  }
  if (-not (Test-Path $nodeExe)) {
    Write-Log ('NODE NOT FOUND: ' + $nodeExe)
    return $false
  }
  Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden
  Write-Log 'started: node server.js'
  return $true
}

Write-Log ('watchdog start  port={0} interval={1}s root={2}' -f $Port, $IntervalSec, $root)

# first pass immediately
if (-not (Test-Healthy)) {
  Write-Log 'first health check FAILED'
  if (Start-App) { Start-Sleep -Seconds $StartupWaitSec }
}

$downCount = 0
while ($true) {
  Start-Sleep -Seconds $IntervalSec
  if (Test-Healthy) {
    if ($downCount -gt 0) { Write-Log ('recovered after {0} failed check(s)' -f $downCount); $downCount = 0 }
    continue
  }
  $downCount++
  Write-Log ('health check FAILED ({0} in a row)' -f $downCount)
  if (Start-App) {
    Start-Sleep -Seconds $StartupWaitSec
    if (Test-Healthy) { Write-Log 'recovered'; $downCount = 0 }
    else { Write-Log 'still down after restart attempt' }
  }
}



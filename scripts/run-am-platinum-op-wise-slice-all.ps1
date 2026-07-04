param(
  [string]$CyStart = '',
  [string]$CyEnd = '',
  [switch]$LyOnly,
  [switch]$CyOnly
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$monthStart = Get-Date -Day 1 -Hour 0 -Minute 0 -Second 0
if (-not $CyStart) {
  $CyStart = $monthStart.ToString('yyyy-MM-dd')
}
if (-not $CyEnd) {
  $CyEnd = (Get-Date).ToString('yyyy-MM-dd')
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $ProjectRoot "logs\am-platinum-op-wise-slice-all-$stamp.log"
$lockDir = Join-Path $ProjectRoot 'temp\gdms-otp-login.lock'
$metaFile = Join-Path $lockDir 'meta.json'

function Test-ProcessAlive([int]$ProcessId) {
  try {
    Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

Write-Host 'AM Platinum Operation Wise comparable slice backfill (all dealers)'
Write-Host "Project: $ProjectRoot"
Write-Host "Log: $log"
Write-Host 'Dealers: N5211, N6250, N6828'
Write-Host "CY window: $CyStart -> $CyEnd"
Write-Host 'Uploads missing CY + LY comparable slices (Operation + Part) per dealer'
Write-Host ''

if (Test-Path $metaFile) {
  $meta = Get-Content $metaFile -Raw | ConvertFrom-Json
  $lockPid = [int]$meta.pid
  if (Test-ProcessAlive $lockPid) {
    Write-Host "Note: clearing GDMS OTP lock held by older background run (PID $lockPid)."
  }
  Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Cleared GDMS OTP lock.'
  Write-Host ''
}

Write-Host 'Keep this window open. Type OTP in this terminal when prompted.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
$env:OTP_PROVIDER = 'manual'
$env:AM_PLATINUM_HISTORICAL_HEADLESS = 'false'
$env:HEADLESS = 'false'
$env:GDMS_OTP_LOCK_ENABLED = 'false'
$env:LOG_SERVICE_NAME = 'am-platinum-op-wise-slice'

$args = @(
  'scripts/backfill-am-platinum-operation-wise-ly-slice.js',
  "--cy-start=$CyStart",
  "--cy-end=$CyEnd"
)

if ($LyOnly) {
  $args += '--ly-only'
} elseif ($CyOnly) {
  $args += '--cy-only'
}

node @args *>&1 | Tee-Object -FilePath $log

Write-Host ''
Write-Host 'Finished. Log saved to:'
Write-Host $log
Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

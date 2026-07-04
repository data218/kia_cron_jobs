$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$today = Get-Date -Format 'yyyy-MM-dd'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $ProjectRoot "logs\am-platinum-operation-wise-$stamp.log"
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

Write-Host 'AM Platinum backfill - Operation Wise Analysis only'
Write-Host "Project: $ProjectRoot"
Write-Host "Log: $log"
Write-Host 'Report: Operation Wise Analysis (Operation + Part types)'
Write-Host 'Dealers: N5211, N6250 (Rajouri), N6828'
Write-Host "Range: 2021-01-01 -> $today"
Write-Host 'Mode: sequential, skip existing months already in DB'
Write-Host ''

if (Test-Path $metaFile) {
  $meta = Get-Content $metaFile -Raw | ConvertFrom-Json
  $lockPid = [int]$meta.pid
  if (Test-ProcessAlive $lockPid) {
    Write-Host "Note: clearing GDMS OTP lock held by older background run (PID $lockPid)."
    Write-Host 'Only one manual run should be active in this window.'
  }
  Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Cleared GDMS OTP lock.'
  Write-Host ''
}

Write-Host 'Keep this window open. Type OTP in this terminal when prompted.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:AM_PLATINUM_OPERATION_WISE_DEALERS = 'N5211,N6250,N6828'
$env:AM_PLATINUM_OPERATION_WISE_START_DATE = '2021-01-01'
$env:AM_PLATINUM_OPERATION_WISE_END_DATE = $today
$env:AM_PLATINUM_OPERATION_WISE_SKIP_EXISTING = 'true'
$env:AM_PLATINUM_OPERATION_WISE_RESET_STATE = 'true'
$env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'false'
$env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
$env:OTP_PROVIDER = 'manual'
$env:AM_PLATINUM_HISTORICAL_HEADLESS = 'false'
$env:HEADLESS = 'false'
$env:GDMS_OTP_LOCK_ENABLED = 'false'
$env:LOG_SERVICE_NAME = 'am-platinum-operation-wise'

node scripts/recover-am-platinum-operation-wise.js *>&1 | Tee-Object -FilePath $log

Write-Host ''
Write-Host 'Finished. Log saved to:'
Write-Host $log
Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

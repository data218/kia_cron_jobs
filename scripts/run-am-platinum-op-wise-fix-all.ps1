param(
  [string]$From = '',
  [string]$To = '',
  [switch]$LyOnly
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$yearStart = (Get-Date -Month 1 -Day 1).ToString('yyyy-MM-dd')
if (-not $From) {
  $From = $yearStart
}
if (-not $To) {
  $To = (Get-Date).ToString('yyyy-MM-dd')
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $ProjectRoot "logs\am-platinum-op-wise-fix-all-$stamp.log"
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

Write-Host 'AM Platinum Operation Wise — fix ALL missing CY + LY comparable slices'
Write-Host "Project: $ProjectRoot"
Write-Host "Log: $log"
Write-Host 'Dealers: N5211, N6250, N6828'
Write-Host "Span: $From -> $To (every month, CY + matching 2025 LY slice)"
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
Write-Host 'This may take a while — one portal session per dealer batch.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
$env:OTP_PROVIDER = 'manual'
$env:AM_PLATINUM_HISTORICAL_HEADLESS = 'false'
$env:HEADLESS = 'false'
$env:GDMS_OTP_LOCK_ENABLED = 'false'
$env:LOG_SERVICE_NAME = 'am-platinum-op-wise-fix-all'

$args = @(
  'scripts/backfill-am-platinum-operation-wise-all-comparable.js',
  "--from=$From",
  "--to=$To"
)

if ($LyOnly) {
  $args += '--ly-only'
}

node @args *>&1 | Tee-Object -FilePath $log

Write-Host ''
Write-Host 'Finished. Log saved to:'
Write-Host $log
Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

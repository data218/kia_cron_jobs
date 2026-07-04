param(
  [string]$StartDate = '2025-01-01',
  [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$lockDir = Join-Path $ProjectRoot 'temp\gdms-otp-login.lock'
if (Test-Path $lockDir) {
  Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Cleared GDMS OTP lock.'
}

Write-Host ''
Write-Host 'AM Platinum remaining reports backfill'
Write-Host "Project: $ProjectRoot"
Write-Host 'Dealers: N5211, N6250, N6828'
Write-Host "Range: $StartDate -> today"
Write-Host ''
Write-Host 'Reports (only the ones still missing):'
Write-Host '  1. Call Center Complaints'
Write-Host '  2. Customer Complaint List'
Write-Host '  3. Demo Car List'
Write-Host '  4. Adv Wise Lubricants VAS'
Write-Host ''
Write-Host 'Skips months already present in DB.'
Write-Host 'Keep this window open. Enter OTP whenever prompted.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:HEADLESS = 'false'
$env:OTP_PROVIDER = 'manual'
$env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
$env:GDMS_OTP_LOCK_ENABLED = 'false'
$env:AM_PLATINUM_FORCE_LOGIN = 'true'
$env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'true'
$env:AM_PLATINUM_REMAINING_START_DATE = $StartDate
$env:LOG_SERVICE_NAME = 'am-platinum-remaining-2025'

if ($Resume) {
  $env:AM_PLATINUM_REMAINING_CLEAR_SESSION = 'false'
  Write-Host 'Resume mode: keeping saved session cache if present.'
} else {
  node scripts/clear-am-platinum-session-cache.js
}

node scripts/run-am-platinum-remaining-reports-2025.js
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host "Some steps failed (exit $LASTEXITCODE). Check logs/am-platinum-remaining-reports-*.log"
}

Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

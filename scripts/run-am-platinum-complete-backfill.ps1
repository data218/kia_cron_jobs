$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$lockDir = Join-Path $ProjectRoot 'temp\gdms-otp-login.lock'
if (Test-Path $lockDir) {
  Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Cleared GDMS OTP lock.'
}

Write-Host ''
Write-Host 'AM Platinum COMPLETE backfill'
Write-Host "Project: $ProjectRoot"
Write-Host 'Dealers: N5211, N6250, N6828 (one browser at a time)'
Write-Host ''
Write-Host 'Date policy:'
Write-Host '  2021 -> today : Operation Wise, Repair Order, RO Billing'
Write-Host '  2024 -> today : all other reports'
Write-Host ''
Write-Host 'Keep this window open. Enter OTP whenever prompted.'
Write-Host 'This runs 11 steps sequentially — may take many hours.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:HEADLESS = 'false'
$env:OTP_PROVIDER = 'manual'
$env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
$env:GDMS_OTP_LOCK_ENABLED = 'false'
$env:AM_PLATINUM_FORCE_LOGIN = 'true'
$env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'true'
$env:LOG_SERVICE_NAME = 'am-platinum-complete-backfill'

node scripts/clear-am-platinum-session-cache.js
node scripts/run-am-platinum-complete-backfill.js
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host "Some steps failed (exit $LASTEXITCODE). Check logs/am-platinum-complete-backfill-*.log"
}

Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

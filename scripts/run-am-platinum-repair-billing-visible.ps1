$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$today = Get-Date -Format 'yyyy-MM-dd'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $ProjectRoot "logs\am-platinum-repair-billing-$stamp.log"

Write-Host 'AM Platinum historical backfill — Repair Order + RO Billing only'
Write-Host "Project: $ProjectRoot"
Write-Host "Log: $log"
Write-Host "Reports: hyundai-repair-order-list, hyundai-ro-billing-report"
Write-Host "Dealers: N5211, N6250, N6828"
Write-Host "Range: 2021-01-01 -> $today"
Write-Host ''
Write-Host 'Keep this window open. Type OTP in this terminal when prompted.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:AM_PLATINUM_HISTORICAL_REPORTS = 'hyundai-repair-order-list,hyundai-ro-billing-report'
$env:AM_PLATINUM_HISTORICAL_START_DATE = '2021-01-01'
$env:AM_PLATINUM_HISTORICAL_END_DATE = $today
$env:AM_PLATINUM_HISTORICAL_DEALERS = 'N5211,N6250,N6828'
$env:AM_PLATINUM_HISTORICAL_HEADLESS = 'false'
$env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'false'
$env:AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE = 'false'
$env:AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE = 'true'
$env:AM_PLATINUM_HISTORICAL_SKIP_EXISTING = 'true'
$env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
$env:OTP_PROVIDER = 'manual'
$env:HEADLESS = 'false'
$env:LOG_SERVICE_NAME = 'am-platinum-repair-billing'

node scripts/run-am-platinum-historical-backfill.js *>&1 | Tee-Object -FilePath $log

Write-Host ''
Write-Host 'Finished. Log saved to:'
Write-Host $log
Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

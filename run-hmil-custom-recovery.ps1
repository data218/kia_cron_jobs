$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "========================================================" -ForegroundColor Green
Write-Host "   Hyundai (HMIL) Custom Historical Recovery Backfill" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "Project: $ProjectRoot"
Write-Host "Reports: Operation Wise, Repair Order List, RO Billing"
Write-Host "Dealers: Runs for ALL HMIL dealers (Sahiltech & MIS5216 IDs)"
Write-Host "OTP: manual - you will be prompted to type it in this window"
Write-Host "Press Ctrl+C to cancel."
Write-Host "========================================================"
Write-Host ""

$env:OTP_PROVIDER = 'manual'
$env:HMIL_HISTORICAL_OTP_PROVIDER = 'manual'
$env:HMIL_HISTORICAL_REPORTS = 'hyundai-repair-order-list,hyundai-ro-billing-report,hyundai-operation-wise-analysis-report'
$env:HMIL_HISTORICAL_HEADLESS = 'false'
$env:HMIL_HISTORICAL_START_DATE = '2021-01-01'
$env:HMIL_HISTORICAL_SKIP_EXISTING = 'true'
$env:HMIL_HISTORICAL_DEALERS = 'ALL'

node scripts/recover-hmil-historical-custom.js

Write-Host ""
Write-Host "Finished recovery. Press Enter to close."
Read-Host

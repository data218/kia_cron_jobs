# Run Kia RO Billing + Open RO Yearly — visible browser, manual OTP in this terminal.
# Usage (from repo root):
#   powershell -NoExit -ExecutionPolicy Bypass -File .\scripts\run-ro-billing-manual.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$env:OTP_PROVIDER = 'manual'
$env:HEADLESS = 'false'
$env:REPORTS_TO_RUN = 'ro-billing,open-ro-yearly'
$env:DRY_RUN_REPORTS = 'false'

Write-Host ''
Write-Host 'Kia RO Billing + Open RO Yearly — manual OTP run'
Write-Host '  Browser: visible (HEADLESS=false)'
Write-Host '  Reports: ro-billing, open-ro-yearly'
Write-Host '  Dealers: JK402 then JK501 (from .env)'
Write-Host '  When prompted, type the KIA OTP in THIS terminal and press Enter.'
Write-Host ''

node src/cron/scheduler.js --once
exit $LASTEXITCODE

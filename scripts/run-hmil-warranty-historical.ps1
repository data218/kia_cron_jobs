$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

Write-Host 'HMIL Warranty historical backfill'
Write-Host "Project: $ProjectRoot"
Write-Host 'Dealers: HMIL_DEALER_CODES from .env'
Write-Host 'OTP: manual — type OTP when prompted for sahiltech, then MIS5216'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:HEADLESS = 'false'
npm run hmil:warranty:historical

Write-Host ''
Write-Host 'Finished. Press Enter to close this window.'
Read-Host

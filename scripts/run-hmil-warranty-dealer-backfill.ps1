$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$dealer = if ($args.Count -gt 0) { $args[0] } else { 'N5203' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $ProjectRoot "logs\hmil-warranty-$dealer-backfill-$stamp.log"

Write-Host "HMIL Warranty backfill for dealer $dealer"
Write-Host "Project: $ProjectRoot"
Write-Host "Log: $logFile"
Write-Host 'Login: sahiltech (HMIL_USER_ID from .env)'
Write-Host 'Keep this window open. Type OTP when prompted.'
Write-Host ''

$env:HEADLESS = 'false'
$env:OTP_PROVIDER = 'manual'
$env:HMIL_WARRANTY_HISTORICAL_OTP_PROVIDER = 'manual'

node scripts/run-hmil-warranty-dealer-backfill.js $dealer *>&1 | Tee-Object -FilePath $logFile -Append
if ($LASTEXITCODE -ne 0) {
  throw "Warranty backfill failed with exit code $LASTEXITCODE"
}

Write-Host ''
Write-Host "Finished. Log: $logFile"
Write-Host "Verify: node scripts/check-hmil-warranty-dealer-coverage.js $dealer"
Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

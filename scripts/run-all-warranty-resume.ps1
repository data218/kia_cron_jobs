$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $ProjectRoot "logs\warranty-full-resume-$stamp.log"
$lockDir = Join-Path $ProjectRoot 'temp\gdms-otp-login.lock'

if (Test-Path $lockDir) {
  Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Cleared GDMS OTP lock.'
}

Write-Host ''
Write-Host 'Warranty resume run — Hyundai + AM Platinum'
Write-Host "Project: $ProjectRoot"
Write-Host "Log: $logFile"
Write-Host ''
Write-Host 'Resume mode:'
Write-Host '  - Keeps existing DB rows (no table clear)'
Write-Host '  - Skips Claim List months already loaded per dealer/login'
Write-Host '  - Claim YTP: 2025-01-01 to today, no Search, page size 300, fast skip if empty'
Write-Host ''
Write-Host 'Keep this window open. Type OTP when prompted.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:HEADLESS = 'false'
$env:OTP_PROVIDER = 'manual'
$env:HMIL_WARRANTY_HISTORICAL_OTP_PROVIDER = 'manual'
$env:GDMS_OTP_LOCK_ENABLED = 'false'
$env:HMIL_WARRANTY_FORCE_LOGIN = 'true'
$env:HMIL_WARRANTY_RESUME = 'true'
$env:AM_PLATINUM_FORCE_LOGIN = 'true'
$env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'true'
$env:LOG_SERVICE_NAME = 'warranty-full-resume'

node scripts/run-all-warranty-full.js *>&1 | Tee-Object -FilePath $logFile -Append
if ($LASTEXITCODE -ne 0) {
  throw "Warranty resume run failed with exit code $LASTEXITCODE"
}

Write-Host ''
Write-Host "Finished. Log: $logFile"
Write-Host 'Press Enter to close.'
Read-Host

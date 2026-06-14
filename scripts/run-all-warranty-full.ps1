$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $ProjectRoot "logs\warranty-full-all-$stamp.log"
$lockDir = Join-Path $ProjectRoot 'temp\gdms-otp-login.lock'

if (Test-Path $lockDir) {
  Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Cleared GDMS OTP lock.'
}

Write-Host ''
Write-Host 'Full warranty run — Hyundai + AM Platinum'
Write-Host "Project: $ProjectRoot"
Write-Host "Log: $logFile"
Write-Host ''
Write-Host 'Sequence:'
Write-Host '  1. Hyundai sahiltech  — all HMIL_DEALER_CODES dealers'
Write-Host '  2. Hyundai MIS5216    — all HMIL_WARRANTY_SECONDARY_DEALER_CODES dealers'
Write-Host '  3. Platinum MIS1988   — all AM_PLATINUM_DEALER_CODES dealers'
Write-Host '  4. Platinum MIS12345  — same dealers (Rajouri as N6824 on historical login)'
Write-Host ''
Write-Host 'Each dealer: Warranty Claim List + Claim YTP'
Write-Host 'Tables are cleared once at start, then all logins append fresh rows.'
Write-Host ''
Write-Host 'Keep this window open. Type OTP when prompted (4 logins total).'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:HEADLESS = 'false'
$env:OTP_PROVIDER = 'manual'
$env:HMIL_WARRANTY_HISTORICAL_OTP_PROVIDER = 'manual'
$env:GDMS_OTP_LOCK_ENABLED = 'false'
$env:HMIL_WARRANTY_FORCE_LOGIN = 'true'
$env:AM_PLATINUM_FORCE_LOGIN = 'true'
$env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'true'
$env:LOG_SERVICE_NAME = 'warranty-full-all'

node scripts/clear-am-platinum-session-cache.js

node scripts/run-all-warranty-full.js *>&1 | Tee-Object -FilePath $logFile -Append
if ($LASTEXITCODE -ne 0) {
  throw "Full warranty run failed with exit code $LASTEXITCODE"
}

Write-Host ''
Write-Host "Finished. Log: $logFile"
Write-Host 'Press Enter to close.'
Read-Host

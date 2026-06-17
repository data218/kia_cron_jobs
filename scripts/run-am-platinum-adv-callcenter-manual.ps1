# AM Platinum: Adv VAS (priority) then Call Center (mid-2025 → today) — manual OTP.
# Usage:
#   powershell -NoExit -ExecutionPolicy Bypass -File .\scripts\run-am-platinum-adv-callcenter-manual.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $env:LOCALAPPDATA 'ms-playwright'
if (-not (Test-Path (Join-Path $env:PLAYWRIGHT_BROWSERS_PATH 'chromium-1223'))) {
  Write-Host 'Installing Playwright Chromium (one-time)...'
  npx playwright install chromium
}

$today = Get-Date -Format 'yyyy-MM-dd'
$env:AM_PLATINUM_HISTORICAL_END_DATE = $today

$lockDir = Join-Path (Get-Location) 'temp\gdms-otp-login.lock'
if (Test-Path $lockDir) {
  Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Cleared GDMS OTP lock.'
}

$env:HEADLESS = 'false'
$env:OTP_PROVIDER = 'manual'
$env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
$env:GDMS_OTP_LOCK_ENABLED = 'false'
$env:AM_PLATINUM_FORCE_LOGIN = 'true'
$env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'true'
$env:AM_PLATINUM_HISTORICAL_HEADLESS = 'false'
$env:AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE = 'false'
$env:AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE = 'true'
$env:AM_PLATINUM_HISTORICAL_DEALERS = 'N5211,N6250,N6828'

Write-Host ''
Write-Host 'AM Platinum manual backfill'
Write-Host '  Step 1 (priority): Adv. wise Lubricants & VAS — month-by-month 2024-01-01 to today (all dealers)'
Write-Host '  Step 2: Call Center Complaints — 2025-07-01 to today (all dealers)'
Write-Host '  Browser: visible | OTP: type in THIS terminal when prompted'
Write-Host ''

node scripts/clear-am-platinum-session-cache.js

Write-Host ''
Write-Host '=== Step 1/2: Adv. wise Lubricants & VAS ==='
$env:AM_PLATINUM_HISTORICAL_REPORTS = 'hyundai-adv-wise-lubricants-vas'
$env:AM_PLATINUM_HISTORICAL_START_DATE = '2024-01-01'
$env:AM_PLATINUM_HISTORICAL_SKIP_EXISTING = 'false'
$env:AM_PLATINUM_HISTORICAL_STATE_FILE = 'am-platinum-adv-vas-historical-state.json'
$env:AM_PLATINUM_HISTORICAL_LOG_PREFIX = 'am-platinum-adv-vas-historical'
$env:LOG_SERVICE_NAME = 'am-platinum-adv-vas-historical'

node scripts/run-am-platinum-historical-backfill.js
if ($LASTEXITCODE -ne 0) {
  Write-Host "Adv VAS exited with code $LASTEXITCODE (continuing to Call Center anyway)."
}

Write-Host ''
Write-Host '=== Step 2/2: Call Center Complaints (mid-2025) ==='
$env:AM_PLATINUM_HISTORICAL_REPORTS = 'hyundai-call-center-complaints'
$env:AM_PLATINUM_HISTORICAL_START_DATE = '2025-07-01'
$env:AM_PLATINUM_HISTORICAL_SKIP_EXISTING = 'true'
$env:AM_PLATINUM_HISTORICAL_STATE_FILE = 'am-platinum-call-center-mid2025-state.json'
$env:AM_PLATINUM_HISTORICAL_LOG_PREFIX = 'am-platinum-call-center-mid2025'
$env:LOG_SERVICE_NAME = 'am-platinum-call-center-mid2025'

node scripts/run-am-platinum-historical-backfill.js
exit $LASTEXITCODE

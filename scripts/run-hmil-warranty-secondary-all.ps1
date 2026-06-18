param(
  [switch]$Resume,
  [switch]$KeepSession
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $ProjectRoot "logs\hmil-warranty-secondary-all-$stamp.log"
$lockDir = Join-Path $ProjectRoot 'temp\gdms-otp-login.lock'

if (Test-Path $lockDir) {
  Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Cleared GDMS OTP lock.'
}

Write-Host ''
Write-Host 'HMIL Warranty secondary backfill (MIS5216 only)'
Write-Host "Project: $ProjectRoot"
Write-Host "Log: $logFile"
Write-Host 'Login: MIS5216 (HMIL_SECONDARY_USER_ID from .env)'
Write-Host 'Dealers: N5216, N6844, N6845, N6846, N6847, N6848'
Write-Host 'Reports: Warranty Claim List + Claim YTP'
Write-Host ''
Write-Host 'Keep this window open. Type OTP when prompted for MIS5216.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

$env:HEADLESS = 'false'
$env:OTP_PROVIDER = 'manual'
$env:HMIL_WARRANTY_HISTORICAL_OTP_PROVIDER = 'manual'
$env:GDMS_OTP_LOCK_ENABLED = 'false'
$env:HMIL_WARRANTY_FORCE_LOGIN = 'true'
$env:HMIL_WARRANTY_FORCE_YTP = 'true'
$env:LOG_SERVICE_NAME = 'hmil-warranty-secondary-all'

if ($Resume) {
  $env:HMIL_WARRANTY_RESUME = 'true'
  Write-Host 'Resume mode: skip Claim List months already loaded for MIS5216.'
} else {
  $env:HMIL_WARRANTY_RESUME = 'false'
  Write-Host 'Full mode: re-export all months (Claim List + YTP).'
}

if ($KeepSession) {
  $env:HMIL_WARRANTY_SECONDARY_CLEAR_SESSION = 'false'
} else {
  $env:HMIL_WARRANTY_SECONDARY_CLEAR_SESSION = 'true'
}

node scripts/run-hmil-warranty-secondary-all.js *>&1 | Tee-Object -FilePath $logFile -Append
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host "Run failed (exit $LASTEXITCODE). Log: $logFile"
  Write-Host 'If login failed, check hmil-warranty-secondary-login-error.png and retry.'
} else {
  Write-Host ''
  Write-Host "Finished. Log: $logFile"
}

Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

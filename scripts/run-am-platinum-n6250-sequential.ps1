$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$today = Get-Date -Format 'yyyy-MM-dd'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$masterLog = Join-Path $ProjectRoot "logs\am-platinum-n6250-sequential-$stamp.log"
$lockDir = Join-Path $ProjectRoot 'temp\gdms-otp-login.lock'
$metaFile = Join-Path $lockDir 'meta.json'
$startDate = '2024-03-01'

function Test-ProcessAlive([int]$ProcessId) {
  try {
    Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Clear-OtpLock {
  if (Test-Path $metaFile) {
    $meta = Get-Content $metaFile -Raw | ConvertFrom-Json
    $lockPid = [int]$meta.pid
    if (Test-ProcessAlive $lockPid) {
      Write-Host "Note: clearing GDMS OTP lock held by older run (PID $lockPid)."
    }
    Remove-Item $lockDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Cleared GDMS OTP lock.'
  }
}

function Set-Mis1988FreshLogin {
  node scripts/clear-am-platinum-session-cache.js
  $env:AM_PLATINUM_FORCE_LOGIN = 'true'
  $env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'true'
  Write-Host 'Force OTP login enabled for MIS1988 (AM_PLATINUM_FORCE_LOGIN=true).'
}

function Set-SharedEnv {
  $env:AM_PLATINUM_HISTORICAL_DEALERS = 'N6250'
  $env:AM_PLATINUM_HISTORICAL_END_DATE = $today
  $env:AM_PLATINUM_HISTORICAL_HEADLESS = 'false'
  $env:HEADLESS = 'false'
  $env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
  $env:OTP_PROVIDER = 'manual'
  $env:AM_PLATINUM_HISTORICAL_SKIP_EXISTING = 'true'
  $env:AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE = 'false'
  $env:AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE = 'true'
  $env:GDMS_OTP_LOCK_ENABLED = 'false'
}

function Invoke-HistoricalStep {
  param(
    [int]$StepNumber,
    [string]$Title,
    [string]$ReportId,
    [string]$StateSuffix,
    [string]$ServiceName
  )

  $stepLog = Join-Path $ProjectRoot "logs\am-platinum-n6250-step$StepNumber-$StateSuffix-$stamp.log"
  Write-Host ''
  Write-Host ('=' * 60)
  Write-Host "Step $StepNumber/4: $Title"
  Write-Host "Report: $ReportId"
  Write-Host "Dealer: N6250 (MIS1988 / ACTIVE)"
  Write-Host "Range: $startDate -> $today"
  Write-Host "Log: $stepLog"
  Write-Host ('=' * 60)
  Write-Host ''

  $env:AM_PLATINUM_HISTORICAL_REPORTS = $ReportId
  $env:AM_PLATINUM_HISTORICAL_START_DATE = $startDate
  $env:AM_PLATINUM_HISTORICAL_STATE_FILE = "am-platinum-historical-$StateSuffix-state.json"
  $env:AM_PLATINUM_HISTORICAL_LOG_PREFIX = "am-platinum-n6250-$StateSuffix"
  $env:LOG_SERVICE_NAME = $ServiceName

  node scripts/run-am-platinum-historical-backfill.js *>&1 | Tee-Object -FilePath $stepLog -Append
  if ($LASTEXITCODE -ne 0) {
    throw "Step $StepNumber failed with exit code $LASTEXITCODE"
  }
}

Write-Host 'AM Platinum N6250 sequential targeted backfill'
Write-Host "Project: $ProjectRoot"
Write-Host "Master log: $masterLog"
Write-Host "Dealer: N6250 (Rajouri, MIS1988 / ACTIVE)"
Write-Host "Range: $startDate -> $today"
Write-Host 'Steps: Operation Wise -> RO Billing -> Repair Order -> Customer Complaints'
Write-Host ''
Write-Host 'Keep this window open. Type OTP in this terminal when prompted.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

Clear-OtpLock
Set-SharedEnv
Set-Mis1988FreshLogin

"N6250 sequential backfill started $stamp" | Out-File -FilePath $masterLog -Encoding utf8

Write-Host ('=' * 60)
Write-Host 'Step 1/4: Operation Wise Analysis (Operation + Part)'
Write-Host "Dealer: N6250 | Range: $startDate -> $today"
$step1Log = Join-Path $ProjectRoot "logs\am-platinum-n6250-step1-op-wise-$stamp.log"
Write-Host "Log: $step1Log"
Write-Host ('=' * 60)
Write-Host ''

$env:AM_PLATINUM_OPERATION_WISE_DEALERS = 'N6250'
$env:AM_PLATINUM_OPERATION_WISE_START_DATE = $startDate
$env:AM_PLATINUM_OPERATION_WISE_END_DATE = $today
$env:AM_PLATINUM_OPERATION_WISE_SKIP_EXISTING = 'true'
$env:AM_PLATINUM_OPERATION_WISE_RESET_STATE = 'true'
$env:LOG_SERVICE_NAME = 'am-platinum-n6250-op-wise'

node scripts/recover-am-platinum-operation-wise.js *>&1 | Tee-Object -FilePath $step1Log -Append
if ($LASTEXITCODE -ne 0) {
  throw "Step 1 (Operation Wise) failed with exit code $LASTEXITCODE"
}

Invoke-HistoricalStep -StepNumber 2 -Title 'RO Billing Report' `
  -ReportId 'hyundai-ro-billing-report' `
  -StateSuffix 'ro-billing-n6250' `
  -ServiceName 'am-platinum-n6250-ro-billing'

Invoke-HistoricalStep -StepNumber 3 -Title 'Repair Order List' `
  -ReportId 'hyundai-repair-order-list' `
  -StateSuffix 'repair-order-n6250' `
  -ServiceName 'am-platinum-n6250-repair-order'

Invoke-HistoricalStep -StepNumber 4 -Title 'Customer Complaint List' `
  -ReportId 'hyundai-customer-complaint-list' `
  -StateSuffix 'customer-complaints-n6250' `
  -ServiceName 'am-platinum-n6250-complaints'

Write-Host ''
Write-Host ('=' * 60)
Write-Host 'All 4 steps completed.'
Write-Host "Master log: $masterLog"
Write-Host 'Run: node scripts/check-operation-wise-dealer-coverage.js'
Write-Host ('=' * 60)
Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path (Get-Location) "logs\am-platinum-two-workprofit-monthly-$stamp.log"

$env:AM_PLATINUM_HISTORICAL_REPORTS = 'hyundai-adv-wise-lubricants-vas,hyundai-operation-wise-analysis-report'
$env:AM_PLATINUM_HISTORICAL_DEALERS = 'N5211,N6250,N6828'
$env:AM_PLATINUM_HISTORICAL_START_DATE = '2021-01-01'
$env:AM_PLATINUM_HISTORICAL_END_DATE = (Get-Date -Format 'yyyy-MM-dd')
$env:AM_PLATINUM_HISTORICAL_HEADLESS = 'false'
$env:AM_PLATINUM_HISTORICAL_PAGE_SIZE = '1000'
$env:AM_PLATINUM_HISTORICAL_SKIP_EXISTING = 'false'
$env:AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE = 'false'
$env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'false'
$env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
$env:OTP_PROVIDER = 'manual'

Write-Host "Starting AM Platinum monthly visible historical backfill..."
Write-Host "Log: $log"
Write-Host "Reports: $env:AM_PLATINUM_HISTORICAL_REPORTS"
Write-Host "Dealers: $env:AM_PLATINUM_HISTORICAL_DEALERS"
Write-Host "Range: $env:AM_PLATINUM_HISTORICAL_START_DATE to $env:AM_PLATINUM_HISTORICAL_END_DATE"

node scripts/run-am-platinum-historical-backfill.js *>&1 | Tee-Object -FilePath $log

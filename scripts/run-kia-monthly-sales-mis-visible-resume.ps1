$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$env:HEADLESS = 'false'
$env:PLAYWRIGHT_BROWSER_CHANNEL = 'chrome'
$env:PLAYWRIGHT_USE_PERSISTENT_CONTEXT = 'true'
$env:PLAYWRIGHT_USER_DATA_DIR = './storage/playwright-browser-profile-visible'
$env:REPORT_DATE_OVERRIDE_START_DATE = '2025-01-01'
$env:REPORT_DATE_OVERRIDE_END_DATE = '2026-06-27'

$logPath = Join-Path $repoRoot 'logs\kia-monthly-mis-visible-resume.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null

Write-Host "Starting visible Kia MIS resume from Sales -> Enquiry -> Accessories in one login session..."
Write-Host "Log: $logPath"

node scripts/run-kia-monthly-sales-mis-visible-resume.js 2>&1 | Tee-Object -FilePath $logPath

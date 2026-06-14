param(
  [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot

$today = Get-Date -Format 'yyyy-MM-dd'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$masterLog = Join-Path $ProjectRoot "logs\am-platinum-priority-gapfill-$stamp.log"
$lockDir = Join-Path $ProjectRoot 'temp\gdms-otp-login.lock'
$metaFile = Join-Path $lockDir 'meta.json'
$earlyStart = '2021-01-01'
$earlyEnd = '2021-03-31'
$opWiseEnd = '2021-06-30'
$trustStart = '2026-06-01'
$priorityOpWiseStateFile = 'am-platinum-priority-op-wise-state.json'
$queueFile = Join-Path $ProjectRoot 'logs\am-platinum-historical-queue.json'

$PriorityReportIds = @(
  'hyundai-repair-order-list',
  'hyundai-ro-billing-report',
  'hyundai-operation-wise-analysis-report',
  'hyundai-trust-package-bodyshop-sot'
)
$PriorityDealers = @('N6250', 'N6828')

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

function Set-SharedEnv {
  param([bool]$ResumeMode)

  $env:HEADLESS = 'false'
  $env:OTP_PROVIDER = 'manual'
  $env:AM_PLATINUM_HISTORICAL_OTP_PROVIDER = 'manual'
  $env:GDMS_OTP_LOCK_ENABLED = 'false'
  $env:AM_PLATINUM_HISTORICAL_HEADLESS = 'false'
  $env:AM_PLATINUM_HISTORICAL_FORCE_LOGIN = 'false'
  $env:AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE = 'false'
  $env:AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE = if ($ResumeMode) { 'true' } else { 'false' }
  $env:LOG_SERVICE_NAME = 'am-platinum-priority-gapfill'
}

function Get-PhaseState([string]$StateSuffix) {
  $statePath = Join-Path $ProjectRoot "logs\am-platinum-priority-$StateSuffix-state.json"
  if (-not (Test-Path $statePath)) {
    return $null
  }

  return Get-Content $statePath -Raw | ConvertFrom-Json
}

function Test-PhaseComplete([string]$StateSuffix) {
  $state = Get-PhaseState $StateSuffix
  return $state -and $state.status -eq 'success'
}

function Test-PhaseResumable([string]$StateSuffix) {
  $state = Get-PhaseState $StateSuffix
  if (-not $state) {
    return $false
  }

  return @('running', 'failed_at_current_range', 'completed_with_failures') -contains $state.status
}

function Clear-FullRunState {
  Get-ChildItem (Join-Path $ProjectRoot 'logs') -Filter 'am-platinum-priority-*-state.json' -ErrorAction SilentlyContinue |
    ForEach-Object {
      Remove-Item $_.FullName -Force
      Write-Host "Removed stale state: $($_.Name)"
    }

  $priorityOpWiseStatePath = Join-Path $ProjectRoot "logs\$priorityOpWiseStateFile"
  if (Test-Path $priorityOpWiseStatePath) {
    Remove-Item $priorityOpWiseStatePath -Force
    Write-Host "Removed stale state: $priorityOpWiseStateFile"
  }
}

function Invoke-HistoricalPhase {
  param(
    [int]$PhaseNumber,
    [string]$Title,
    [string]$ReportId,
    [string]$Dealers,
    [string]$StartDate,
    [string]$EndDate,
    [string]$SkipExisting,
    [string]$StateSuffix,
    [string]$ServiceName
  )

  $phaseLog = Join-Path $ProjectRoot "logs\am-platinum-priority-phase$PhaseNumber-$StateSuffix-$stamp.log"
  Write-Host ''
  Write-Host ('=' * 60)
  Write-Host "Phase $PhaseNumber/4: $Title"
  Write-Host "Report(s): $ReportId"
  Write-Host "Dealers: $Dealers"
  Write-Host "Range: $StartDate to $EndDate"
  Write-Host "SKIP_EXISTING: $SkipExisting"
  Write-Host "Log: $phaseLog"
  Write-Host ('=' * 60)
  Write-Host ''

  $env:AM_PLATINUM_HISTORICAL_REPORTS = $ReportId
  $env:AM_PLATINUM_HISTORICAL_DEALERS = $Dealers
  $env:AM_PLATINUM_HISTORICAL_START_DATE = $StartDate
  $env:AM_PLATINUM_HISTORICAL_END_DATE = $EndDate
  $env:AM_PLATINUM_HISTORICAL_SKIP_EXISTING = $SkipExisting
  $env:AM_PLATINUM_HISTORICAL_STATE_FILE = "am-platinum-priority-$StateSuffix-state.json"
  $env:AM_PLATINUM_HISTORICAL_LOG_PREFIX = "am-platinum-priority-$StateSuffix"
  $env:LOG_SERVICE_NAME = $ServiceName

  node scripts/run-am-platinum-historical-backfill.js *>&1 | Tee-Object -FilePath $phaseLog -Append
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host "Phase $PhaseNumber failed with exit code $LASTEXITCODE. Continuing with remaining phases."
  }
}

function Get-PhaseNoRowNotes {
  $notes = @()

  foreach ($suffix in @('repair-order', 'ro-billing', 'trust-package')) {
    $state = Get-PhaseState $suffix
    if (-not $state -or -not $state.results) {
      continue
    }

    foreach ($result in $state.results) {
      if ($result.dbAction -eq 'no_rows' -or ($result.rowCount -eq 0 -and $result.status -eq 'success')) {
        $notes += "Phase state $suffix : $($result.dealerCode) $($result.reportId) $($result.startIso) to $($result.endIso) = portal empty (no_rows)"
      }
    }
  }

  return $notes
}

function Show-PriorityGapSummary {
  Write-Host ''
  Write-Host ('=' * 60)
  Write-Host 'Priority gap summary (N6250 / N6828 only)'
  Write-Host ('=' * 60)
  Write-Host ''

  if (-not (Test-Path $queueFile)) {
    Write-Host "Queue file not found: $queueFile"
    return
  }

  $queuePayload = Get-Content $queueFile -Raw | ConvertFrom-Json
  $priorityQueue = @($queuePayload.queue | Where-Object {
    $PriorityReportIds -contains $_.reportId -and $PriorityDealers -contains $_.dealerCode
  })

  if ($priorityQueue.Count -eq 0) {
    Write-Host 'All 4 priority report/dealer gaps are closed (or portal-empty confirmed).'
  } else {
    Write-Host "Remaining priority gaps: $($priorityQueue.Count)"
    Write-Host ''
    foreach ($item in $priorityQueue) {
      Write-Host "  $($item.dealerCode) | $($item.reportId) | $($item.reason)"
    }
  }

  $noRowNotes = Get-PhaseNoRowNotes
  if ($noRowNotes.Count -gt 0) {
    Write-Host ''
    Write-Host 'Portal empty this run (not a code failure):'
    foreach ($note in $noRowNotes) {
      Write-Host "  - $note"
    }
  }

  Write-Host ''
  Write-Host "Full queue: $queueFile"
}

Write-Host 'AM Platinum priority historical gap-fill'
if ($Resume) {
  Write-Host 'Mode: resume (skips completed phases; keeps state files)'
} else {
  Write-Host 'Mode: full one-shot (runs all 4 phases; clears priority state)'
}
Write-Host "Project: $ProjectRoot"
Write-Host "Master log: $masterLog"
Write-Host ''
Write-Host 'Phases (MIS12345 / MIS1988 only - no HMIL / sahiltech):'
Write-Host "  1. Repair Order - N6250, N6828 ($earlyStart to $earlyEnd, SKIP_EXISTING=false)"
Write-Host "  2. RO Billing - N6828 ($earlyStart to $earlyEnd, SKIP_EXISTING=false)"
if ($Resume) {
  Write-Host "  3. Operation Wise - N6250, N6828 ($earlyStart to $opWiseEnd, SKIP_EXISTING=true)"
} else {
  Write-Host "  3. Operation Wise - N6250, N6828 ($earlyStart to $opWiseEnd, SKIP_EXISTING=false)"
}
Write-Host "  4. Trust Package - N6828 ($trustStart to $today, SKIP_EXISTING=false)"
Write-Host ''
Write-Host 'Keep this window open. Type OTP in this terminal when prompted.'
Write-Host 'MIS12345 for early 2021 / N6828; MIS1988 when Rajouri post-2024 ranges apply.'
Write-Host 'Press Ctrl+C to stop. Use -Resume or npm run am-platinum:priority-gapfill:resume to continue later.'
Write-Host ''

Clear-OtpLock
Set-SharedEnv -ResumeMode:$Resume

if (-not $Resume) {
  Clear-FullRunState
  node scripts/clear-am-platinum-session-cache.js
} else {
  $resumePhase2 = Test-PhaseResumable 'ro-billing'
  if ($resumePhase2) {
    Write-Host 'Resume: continuing from saved phase state where possible.'
    Write-Host ''
  }
}

"Priority gap-fill started $stamp (resume=$Resume)" | Out-File -FilePath $masterLog -Encoding utf8

$skipPhase1 = $Resume -and (Test-PhaseResumable 'ro-billing')

if (-not $skipPhase1 -and (-not $Resume -or -not (Test-PhaseComplete 'repair-order'))) {
  Invoke-HistoricalPhase `
    -PhaseNumber 1 `
    -Title 'Repair Order (early 2021 gap)' `
    -ReportId 'hyundai-repair-order-list' `
    -Dealers 'N6250,N6828' `
    -StartDate $earlyStart `
    -EndDate $earlyEnd `
    -SkipExisting 'false' `
    -StateSuffix 'repair-order' `
    -ServiceName 'am-platinum-priority-repair-order'
} else {
  Write-Host 'Skipping Phase 1 (complete or deferred while resuming Phase 2).'
}

if (-not $Resume -or -not (Test-PhaseComplete 'ro-billing')) {
  Invoke-HistoricalPhase `
    -PhaseNumber 2 `
    -Title 'RO Billing (early 2021 gap)' `
    -ReportId 'hyundai-ro-billing-report' `
    -Dealers 'N6828' `
    -StartDate $earlyStart `
    -EndDate $earlyEnd `
    -SkipExisting 'false' `
    -StateSuffix 'ro-billing' `
    -ServiceName 'am-platinum-priority-ro-billing'
} else {
  Write-Host 'Skipping Phase 2 (already complete).'
}

$phase3Log = Join-Path $ProjectRoot "logs\am-platinum-priority-phase3-op-wise-$stamp.log"
$opWiseSkipExisting = if ($Resume) { 'true' } else { 'false' }
$opWiseResetState = if ($Resume) { 'false' } else { 'true' }

Write-Host ''
Write-Host ('=' * 60)
Write-Host 'Phase 3/4: Operation Wise (early 2021 gap)'
Write-Host 'Report: Operation Wise Analysis (Operation + Part types)'
Write-Host 'Dealers: N6250, N6828'
Write-Host "Range: $earlyStart to $opWiseEnd"
Write-Host "SKIP_EXISTING: $opWiseSkipExisting"
Write-Host "Log: $phase3Log"
Write-Host ('=' * 60)
Write-Host ''

$env:AM_PLATINUM_OPERATION_WISE_DEALERS = 'N6250,N6828'
$env:AM_PLATINUM_OPERATION_WISE_START_DATE = $earlyStart
$env:AM_PLATINUM_OPERATION_WISE_END_DATE = $opWiseEnd
$env:AM_PLATINUM_OPERATION_WISE_SKIP_EXISTING = $opWiseSkipExisting
$env:AM_PLATINUM_OPERATION_WISE_RESET_STATE = $opWiseResetState
$env:AM_PLATINUM_OPERATION_WISE_STATE_FILE = $priorityOpWiseStateFile
$env:LOG_SERVICE_NAME = 'am-platinum-priority-op-wise'

$skipPhase3 = $false
if ($Resume) {
  $opWiseStatePath = Join-Path $ProjectRoot "logs\$priorityOpWiseStateFile"
  if ((Test-Path $opWiseStatePath) -and ((Get-Content $opWiseStatePath -Raw | ConvertFrom-Json).status -eq 'success')) {
    $skipPhase3 = $true
  }
}

if (-not $skipPhase3) {
  node scripts/recover-am-platinum-operation-wise.js *>&1 | Tee-Object -FilePath $phase3Log -Append
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host "Phase 3 failed with exit code $LASTEXITCODE. Continuing with Phase 4."
  }
} else {
  Write-Host 'Skipping Phase 3 (operation-wise recovery already complete).'
}

if (-not $Resume -or -not (Test-PhaseComplete 'trust-package')) {
  Invoke-HistoricalPhase `
    -PhaseNumber 4 `
    -Title 'Trust Package (Jun 2026 gap)' `
    -ReportId 'hyundai-trust-package-bodyshop-sot,hyundai-trust-package-sot-super,hyundai-trust-package-package-list' `
    -Dealers 'N6828' `
    -StartDate $trustStart `
    -EndDate $today `
    -SkipExisting 'false' `
    -StateSuffix 'trust-package' `
    -ServiceName 'am-platinum-priority-trust-package'
} else {
  Write-Host 'Skipping Phase 4 (already complete).'
}

Write-Host ''
Write-Host ('=' * 60)
Write-Host 'All phases finished. Refreshing portal-empty acceptance and running coverage...'
Write-Host ('=' * 60)
Write-Host ''

node scripts/refresh-am-platinum-portal-acceptance.js *>&1 | Tee-Object -FilePath $masterLog -Append
npm run am-platinum:coverage *>&1 | Tee-Object -FilePath $masterLog -Append

Show-PriorityGapSummary

Write-Host ''
Write-Host 'Finished. Logs saved under logs\am-platinum-priority-*'
Write-Host "Master log: $masterLog"
Write-Host ''
Write-Host 'Press Enter to close.'
Read-Host

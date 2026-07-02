$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $repoRoot 'logs\pm2-am-platinum-manual-once-out.log'
$errorFile = Join-Path $repoRoot 'logs\pm2-am-platinum-manual-once-error.log'

Set-Location $repoRoot

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) | Out-Null

$env:NODE_ENV = 'production'
$env:LOG_SERVICE_NAME = 'am-platinum-manual-once'
$env:AM_PLATINUM_SKIP_PHASE1 = 'false'

"[$(Get-Date -Format s)] Starting AM Platinum manual one-off run" | Out-File -FilePath $logFile -Append -Encoding utf8

try {
  & node src/cron/am-platinum-scheduler.js --once *>> $logFile
  $exitCode = $LASTEXITCODE
} catch {
  $_ | Out-File -FilePath $errorFile -Append -Encoding utf8
  $exitCode = 1
}

"[$(Get-Date -Format s)] Manual one-off finished with exit code $exitCode" | Out-File -FilePath $logFile -Append -Encoding utf8

& pm2 restart ecosystem.config.cjs --only am-platinum-cron-job --update-env *>> $logFile
& pm2 save *>> $logFile

exit $exitCode

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeScript = Join-Path $ProjectRoot 'run-hmil-warranty-sahiltech-ytp.js'
$env:NODE_PATH = Join-Path $ProjectRoot 'node_modules'

$logFile = Join-Path $ProjectRoot 'logs\hmil-warranty-ytp-run.log'
if (-not (Test-Path (Split-Path $logFile))) {
    New-Item -Path (Split-Path $logFile) -ItemType Directory -Force | Out-Null
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'pwsh'
$psi.Arguments = @('-NoExit', '-NoLogo', '-Command', "& '$NodeScript' *>&1 | Tee-Object -FilePath '$logFile'")
$psi.WorkingDirectory = $ProjectRoot
$psi.UseShellExecute = $false
$psi.WindowStyle = 'Normal'

$process = [System.Diagnostics.Process]::Start($psi)
Write-Output $process.Id

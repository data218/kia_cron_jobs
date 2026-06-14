param(
  [string]$Script = 'node scripts\run-hmil-warranty-sahiltech-ytp.js',
  [int]$TimeoutMinutes = 15
)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell'
$psi.Arguments = @('-NoExit', '-Command', $Script)
$psi.UseShellExecute = $true
$psi.WindowStyle = 'Normal'

$process = [System.Diagnostics.Process]::Start($psi)
if (-not $process.WaitForExit(60000 * $TimeoutMinutes)) {
  $process.Kill()
  Write-Error "Launcher timed out after $TimeoutMinutes minute(s) and terminated the OTP session."
  exit 1
}

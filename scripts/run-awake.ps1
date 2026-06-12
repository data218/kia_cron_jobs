param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Command
)

if (-not $Command -or $Command.Count -eq 0) {
  Write-Error "Usage: .\scripts\run-awake.ps1 npm run reports"
  exit 2
}

$typeName = "KiaCronAwakeNative"
if (-not ([System.Management.Automation.PSTypeName]$typeName).Type) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class KiaCronAwakeNative {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
}

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]0x00000001
$ES_DISPLAY_REQUIRED = [uint32]0x00000002

$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED
[void][KiaCronAwakeNative]::SetThreadExecutionState($flags)

try {
  Write-Host "Keeping Windows awake while command runs: $($Command -join ' ')"
  $exe = $Command[0]
  $arguments = @()
  if ($Command.Count -gt 1) {
    $arguments = $Command[1..($Command.Count - 1)]
  }

  & $exe @arguments
  exit $LASTEXITCODE
} finally {
  [void][KiaCronAwakeNative]::SetThreadExecutionState($ES_CONTINUOUS)
}

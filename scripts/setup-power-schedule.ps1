# Setup-Power-Schedule.ps1
# This script sets up automatic shutdown at 12:00 AM and automatic wake at 8:00 AM.

$ShutdownTime = "12:00 AM"
$WakeTime = "8:00 AM"

Write-Host "Registering Auto-Shutdown Task..." -ForegroundColor Green
$ShutdownAction = New-ScheduledTaskAction -Execute "shutdown.exe" -Argument "/s /f /t 60"
$ShutdownTrigger = New-ScheduledTaskTrigger -Daily -At $ShutdownTime
$ShutdownSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "AutoShutdownAtMidnight" -Action $ShutdownAction -Trigger $ShutdownTrigger -Settings $ShutdownSettings -User "SYSTEM" -Force

Write-Host "Registering Auto-Wake Task..." -ForegroundColor Green
# A dummy action to trigger the wake-up timer
$WakeAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c echo Waking up computer"
$WakeTrigger = New-ScheduledTaskTrigger -Daily -At $WakeTime
# WakeToRun triggers the hardware ACPI wake timer
$WakeSettings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "AutoWakeAtEightAM" -Action $WakeAction -Trigger $WakeTrigger -Settings $WakeSettings -User "SYSTEM" -Force

Write-Host "`nTasks registered successfully!" -ForegroundColor Green
Write-Host "Important: For wake-up to work:"
Write-Host "1. Put the laptop to Sleep or Hibernate instead of fully shutting down."
Write-Host "2. Enable 'Wake Timers' in Windows Power Options:"
Write-Host "   - Search for 'Edit Power Plan' > 'Change advanced power settings' > 'Sleep' > 'Allow wake timers' > Set to 'Enable'."
Write-Host "3. If you perform a FULL Shutdown, you must enable the 'RTC Alarm' / 'Resume by Alarm' feature inside your laptop's BIOS/UEFI settings instead."

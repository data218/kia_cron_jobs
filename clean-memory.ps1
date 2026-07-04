# PowerShell script to clean system memory (empty working sets for all processes)
# This script releases physical memory (RAM) occupied by processes that isn't actively in use.

$code = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class MemoryCleaner {
    [DllImport("psapi.dll", SetLastError = true)]
    public static extern bool EmptyWorkingSet(IntPtr hProcess);

    public static void CleanAll() {
        Process[] processes = Process.GetProcesses();
        int successCount = 0;
        int failCount = 0;
        long bytesFreed = 0;

        foreach (Process p in processes) {
            try {
                // Skip System Idle and System process
                if (p.Id == 0 || p.Id == 4) continue;
                
                long before = p.WorkingSet64;
                bool success = EmptyWorkingSet(p.Handle);
                if (success) {
                    p.Refresh();
                    long after = p.WorkingSet64;
                    long diff = before - after;
                    if (diff > 0) {
                        bytesFreed += diff;
                    }
                    successCount++;
                } else {
                    failCount++;
                }
            } catch {
                failCount++;
            }
        }
        double mbFreed = Math.Round((double)bytesFreed / (1024 * 1024), 2);
        Console.WriteLine("Memory cleaning completed.");
        Console.WriteLine("Processes cleaned successfully: " + successCount);
        Console.WriteLine("Processes skipped (access denied): " + failCount);
        Console.WriteLine("Total RAM freed: " + mbFreed + " MB");
    }
}
'@

try {
    # Check if type is already defined to avoid errors on repeated runs in the same session
    if (-not ([System.Management.Automation.PSTypeName]'MemoryCleaner').Type) {
        Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
    }
    [MemoryCleaner]::CleanAll()
} catch {
    Write-Error "Failed to compile or run the memory cleaner: $_"
}

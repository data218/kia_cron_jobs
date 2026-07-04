param(
    [string]$SupabaseToken,
    [string]$ProjectRef
)

# Load env variables from .env if it exists in the current directory
$envFile = ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        # Match lines like KEY=VALUE, ignore comments (#)
        if ($_ -match '^\s*([^#=\s]+)\s*=\s*(.*)$') {
            $key = $Matches[1].Trim()
            $value = $Matches[2].Trim()
            # Remove enclosing quotes if any
            if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") {
                $value = $Matches[1]
            }
            if (-not [string]::IsNullOrEmpty($key)) {
                # Set in current process environment so $env:KEY works
                [System.Environment]::SetEnvironmentVariable($key, $value)
            }
        }
    }
}

# Resolve defaults from environment variables
if ([string]::IsNullOrEmpty($SupabaseToken)) {
    $SupabaseToken = $env:SUPABASE_ACCESS_TOKEN
}
if ([string]::IsNullOrEmpty($ProjectRef)) {
    $ProjectRef = "crreoeautoqzcgtlwlsd" # Default fallback
}

# Extract ProjectRef dynamically from SUPABASE_URL or DATABASE_URL if present
if ($env:SUPABASE_URL -match 'https?://([^./]+)\.supabase') {
    $ProjectRef = $Matches[1]
} elseif ($env:DATABASE_URL -match 'postgres\.([^:@/]+)(?::|@)') {
    $ProjectRef = $Matches[1]
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "            Database Restart Control Script" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "Project Reference: $ProjectRef" -ForegroundColor Gray

# 1. Check if a local PostgreSQL service is installed
$pgService = Get-Service | Where-Object { $_.Name -like "*postgres*" -or $_.DisplayName -like "*postgres*" } | Select-Object -First 1

if ($pgService) {
    Write-Host "Found local PostgreSQL service: $($pgService.DisplayName) ($($pgService.Status))" -ForegroundColor Yellow
    Write-Host "Restarting local service..." -ForegroundColor Yellow
    try {
        Restart-Service -Name $pgService.Name -Force -ErrorAction Stop
        Write-Host "✅ Local PostgreSQL service restarted successfully!" -ForegroundColor Green
    } catch {
        Write-Error "Failed to restart local PostgreSQL service: $_"
    }
} else {
    Write-Host "No local PostgreSQL service found." -ForegroundColor Gray
    
    # 2. Try restarting the remote Supabase project
    if ([string]::IsNullOrEmpty($SupabaseToken)) {
        Write-Host ""
        Write-Host "To restart your remote Supabase database ($ProjectRef), you need a Supabase Access Token." -ForegroundColor Yellow
        Write-Host "You can generate one here: https://supabase.com/dashboard/account/tokens" -ForegroundColor Yellow
        Write-Host "Alternatively, add 'SUPABASE_ACCESS_TOKEN=your_token_here' directly to your .env file." -ForegroundColor Yellow
        $SupabaseToken = Read-Host "Please enter your Supabase Access Token (or press Enter to skip)"
    }
    
    if (-not [string]::IsNullOrEmpty($SupabaseToken)) {
        Write-Host "Sending restart request to Supabase API for project $ProjectRef..." -ForegroundColor Yellow
        
        $headers = @{
            "Authorization" = "Bearer $SupabaseToken"
            "Content-Type"  = "application/json"
        }
        
        $url = "https://api.supabase.com/v1/projects/$ProjectRef/restart"
        
        try {
            $response = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -ErrorAction Stop
            Write-Host "✅ Supabase project restart triggered successfully!" -ForegroundColor Green
            Write-Host "The database is now restarting. It will take 1-2 minutes to be fully online." -ForegroundColor Green
        } catch {
            Write-Host "❌ Failed to trigger Supabase project restart." -ForegroundColor Red
            Write-Host "Error Details: $_" -ForegroundColor Red
            if ($_.Exception.Response) {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $responseBody = $reader.ReadToEnd()
                Write-Host "Response body: $responseBody" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "No access token provided. Skipping Supabase restart." -ForegroundColor Gray
    }
}

Write-Host "========================================================" -ForegroundColor Cyan

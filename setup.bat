@echo off
title Kia Insurance Dashboard - Installer
color 0B
echo.
echo  ============================================
echo   Kia Insurance Dashboard - Auto Installer
echo  ============================================
echo.

echo [1/6] Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found!
    echo Download from https://nodejs.org and install, then run this again.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do echo   OK - %%i

echo.
echo [2/6] Installing npm dependencies...
call npm install --no-audit --no-fund
if %errorlevel% neq 0 (
    echo ERROR: npm install failed!
    pause
    exit /b 1
)
echo   OK - Dependencies installed

echo.
echo [3/6] Creating .env config...
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo   Created .env from template - edit it with your credentials
    ) else (
        echo   No .env.example found, skipping
    )
) else (
    echo   .env already exists, skipping
)

echo.
echo [4/6] Installing Playwright Chromium browser...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo WARNING: Playwright install may have issues, continuing anyway...
)
echo   OK - Browser installed

echo.
echo [5/6] Verifying Supabase connection...
node -e "import('@supabase/supabase-js').then(({createClient})=>{const s=createClient(process.env.SUPABASE_URL||'',process.env.SUPABASE_SERVICE_ROLE_KEY||'');s.from('kia_insurance').select('id',{count:'exact',head:true}).then(({error})=>{if(error)throw error;console.log('  OK - Supabase connected')}).catch(e=>{console.log('  WARNING: '+e.message+' (edit .env)')})}).catch(()=>console.log('  WARNING: Could not verify'))" 2>nul

echo.
echo [6/6] Starting dashboard...
echo.
echo  ============================================
echo   INSTALLATION COMPLETE!
echo  ============================================
echo.
echo   Dashboard: http://localhost:3456
echo   Edit .env to set your Supabase/portal credentials
echo   Daily cron: pm2 start ecosystem.config.cjs --only kia-safety-daily
echo.
echo  Opening dashboard in browser...
start http://localhost:3456
echo.

set /p choice="Start dashboard now? (y/n): "
if /i "%choice%"=="y" (
    node server.js
) else (
    echo Run 'node server.js' or 'npm run dashboard' to start anytime.
    pause
)

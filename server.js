import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.DASHBOARD_PORT || 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let isInstalling = false;
let installLogs = [];
let installDone = false;
let installError = null;

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  } catch (e) {
    return e.stdout || e.stderr || e.message;
  }
}

function fileExists(p) {
  return fs.access(p).then(() => true).catch(() => false);
}

app.get('/api/setup-check', async (req, res) => {
  const checks = {};
  try {
    const nodeV = run('node --version').trim();
    checks.node = { ok: true, value: nodeV };
  } catch { checks.node = { ok: false }; }
  try {
    const npmV = run('npm --version').trim();
    checks.npm = { ok: true, value: npmV };
  } catch { checks.npm = { ok: false }; }
  try { await import('playwright'); checks.playwright = { ok: true }; } catch { checks.playwright = { ok: false }; }
  try { await import('@supabase/supabase-js'); checks.supabase = { ok: true }; } catch { checks.supabase = { ok: false }; }
  try { await import('express'); checks.express = { ok: true }; } catch { checks.express = { ok: false }; }
  checks.env = { ok: await fileExists(path.join(__dirname, '.env')) };
  checks.nodeModules = { ok: await fileExists(path.join(__dirname, 'node_modules')) };
  try {
    const playwrightInstalled = run('npx playwright install --dry-run chromium 2>&1');
    checks.browsers = { ok: !playwrightInstalled.includes('not installed') && !playwrightInstalled.includes('MISSING') };
  } catch { checks.browsers = { ok: false }; }
  const allOk = Object.values(checks).every(c => c.ok);
  res.json({ ready: allOk, checks });
});

app.post('/api/install', async (req, res) => {
  if (isInstalling) {
    return res.json({ status: 'busy', logs: installLogs });
  }
  isInstalling = true;
  installLogs = [];
  installDone = false;
  installError = null;

  const log = (msg) => { installLogs.push({ t: Date.now(), msg }); };

  res.json({ status: 'started' });

  (async () => {
    try {
      log('Starting automatic installation...');

      if (!await fileExists(path.join(__dirname, '.env'))) {
        log('Creating .env from template...');
        const envExample = `# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Kia Safety VISOF Portal
KIA_SAFETY_URL=https://www.kiasafety.com/VISOF/Report/VSPolicy_SummaryReport.aspx
KIA_SAFETY_LOGIN_URL=https://www.kiasafety.com/VISOF/Login.aspx
KIA_SAFETY_USER_ID=your_portal_user_id
KIA_SAFETY_PASSWORD=your_portal_password
KIA_SAFETY_SHEET_NAME=kia_insurance
KIA_SAFETY_TABLE_HEADERS=Sno,BRAND,State,Location,DealerCode,Dealer,policy_effective_date,Policy_expiry_date,InsuranceCompany,PolicyNo,PolicyType,Class,ProductType,Model,FuelType,Variant,VinNo,EngineNo,Create_Date,PaymentGenerated,PaymentNo,PaymentMode,ODDiscount,Cancelled,Cancelled_Date,Endorsed,ChequeNo,TotalIDV,NetODPremiumA,NetPremium,IGST,CGST,SGST,UGST,GrossPremium,CUSTOMER_NAME,Package_Name,NCB_SLAB_PER,VEH_REGIST_NO,MFG_YEAR,ACH_CC_Status,Prev_POLICY_NO,Prev_IC_NAME,Quotation_No,IS_LONGTERM,IS_CRP
KIA_SAFETY_HISTORICAL_BACKFILL_ENABLED=false
KIA_SAFETY_DAILY_MODE_ENABLED=true
HEADLESS=true`;
        await fs.writeFile(path.join(__dirname, '.env'), envExample, 'utf-8');
        log('.env created — edit it with your Supabase & portal credentials.');
      } else {
        log('.env already exists, skipping.');
      }

      log('Running npm install (this may take a minute)...');
      const npmOut = run('npm install --no-audit --no-fund', { cwd: __dirname });
      log('npm install completed.');

      log('Installing Playwright Chromium browser...');
      const pwOut = run('npx playwright install chromium', { cwd: __dirname, timeout: 600000 });
      log('Playwright Chromium installed.');

      log('Verifying Supabase connection...');
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(
          process.env.SUPABASE_URL || '',
          process.env.SUPABASE_SERVICE_ROLE_KEY || ''
        );
        const { error } = await supabase.from('kia_insurance').select('id', { count: 'exact', head: true });
        if (error) throw error;
        log('Supabase connected successfully.');
      } catch (e) {
        log('Supabase connection check failed: ' + e.message + ' (edit .env if needed)');
      }

      log('');
      log('=== INSTALLATION COMPLETE ===');
      log('Dashboard: http://localhost:' + PORT);
      log('Run: npm run dashboard');
      log('Daily cron: pm2 start ecosystem.config.cjs --only kia-safety-daily');
      installDone = true;
    } catch (err) {
      installError = err.message;
      log('ERROR: ' + err.message);
    } finally {
      isInstalling = false;
    }
  })();
});

app.get('/api/install-status', (req, res) => {
  res.json({ isInstalling, done: installDone, error: installError, logs: installLogs });
});

// Keep existing Supabase/fetch endpoints lazy-loaded
let supabaseModule = null;
async function getSupabase() {
  if (!supabaseModule) {
    const { createSupabaseClient } = await import('./src/supabase/client.js');
    supabaseModule = createSupabaseClient;
  }
  return supabaseModule();
}

let kiaReportModule = null;
async function getKiaReport() {
  if (!kiaReportModule) {
    kiaReportModule = await import('./src/reports/kia-safety.js');
  }
  return kiaReportModule;
}

let isFetching = false;
let lastFetchResult = null;

async function fetchKiaCredentials() {
  try {
    const supabase = await getSupabase();
    const { data } = await supabase.from('kia_credentials').select('username, password').eq('id', 1).single();
    if (data) {
      process.env.KIA_SAFETY_USER_ID = data.username;
      process.env.KIA_SAFETY_PASSWORD = data.password;
    }
  } catch {}
}

async function fetchAllRows(tableName, select = '*', orderBy = 'create_date') {
  const supabase = await getSupabase();
  const PAGE = 1000;
  let from = 0;
  let allRows = [];
  while (true) {
    const { data, error } = await supabase.from(tableName).select(select).order(orderBy, { ascending: false }).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return allRows;
}

app.get('/api/data', async (req, res) => {
  try {
    const rows = await fetchAllRows('kia_insurance');
    res.json({ rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/summary', async (req, res) => {
  try {
    const rows = await fetchAllRows('kia_insurance', 'create_date, model, insurancecompany, policytype, netodpremiuma, totalidv, vinno, customer_name, policyno, state');
    const monthCounts = {};
    rows.forEach(r => { const m = r.create_date?.substring(0, 7); if (m) monthCounts[m] = (monthCounts[m] || 0) + 1; });
    const tp = rows.reduce((s, r) => s + (Number(r.netodpremiuma) || 0), 0);
    const tidv = rows.reduce((s, r) => s + (Number(r.totalidv) || 0), 0);
    const nc = rows.filter(r => r.policytype === 'New').length;
    const rc = rows.filter(r => r.policytype === 'Renewal').length;
    const models = [...new Set(rows.map(r => r.model).filter(Boolean))].sort();
    const companies = [...new Set(rows.map(r => r.insurancecompany).filter(Boolean))].sort();
    const states = [...new Set(rows.map(r => r.state).filter(Boolean))].sort();
    const uniqueVins = new Set(rows.map(r => r.vinno).filter(Boolean)).size;
    const months = Object.keys(monthCounts).sort();
    const today = new Date();
    const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const todayRows = rows.filter(r => r.create_date === todayDate);
    const todayPremium = todayRows.reduce((s, r) => s + (Number(r.netodpremiuma) || 0), 0);
    const todayNew = todayRows.filter(r => r.policytype === 'New').length;
    const todayRenewal = todayRows.filter(r => r.policytype === 'Renewal').length;
    res.json({ totalPolicies: rows.length, totalPremium: tp, totalIDV: tidv, newPolicies: nc, renewalPolicies: rc, uniqueVINs: uniqueVins, models, companies, states, months, monthCounts, todayDate, todayCount: todayRows.length, todayNew, todayRenewal, todayPremium, lastUpdated: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fetch-kia', async (req, res) => {
  if (isFetching) return res.status(409).json({ error: 'A fetch is already in progress', status: 'busy' });
  isFetching = true;
  lastFetchResult = null;
  const { fromDate, toDate } = req.body || {};
  const today = new Date();
  const def = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const from = fromDate || def;
  const to = toDate || def;
  res.json({ status: 'started', fromDate: from, toDate: to });

  (async () => {
    let browser = null;
    try {
      const { chromium } = await import('playwright');
      const { downloadKiaSafetyReport } = (await import('./src/reports/kia-safety.js'));
      const { ensureRuntimeDirs } = (await import('./src/utils/runtime-dirs.js'));

      await ensureRuntimeDirs();
      await fetchKiaCredentials();
      process.env.KIA_SAFETY_FROM_DATE = from;
      process.env.KIA_SAFETY_TO_DATE = to;
      delete process.env.KIA_SAFETY_DAILY_MODE_ENABLED;

      browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
      const context = await browser.newContext({ acceptDownloads: true });
      context.setDefaultTimeout(120000);
      const page = await context.newPage();
      page.on('dialog', async d => { await d.dismiss().catch(() => {}); });
      const result = await downloadKiaSafetyReport(page, { mode: 'kia-safety-manual' });
      lastFetchResult = { status: 'ok', result, completedAt: new Date().toISOString() };
    } catch (err) {
      lastFetchResult = { status: 'error', error: err.message, completedAt: new Date().toISOString() };
    } finally {
      if (browser) await browser.close().catch(() => {});
      isFetching = false;
    }
  })();
});

app.get('/api/fetch-status', (req, res) => {
  res.json({ isFetching, lastResult: lastFetchResult });
});

app.listen(PORT, () => {
  console.log(`Kia Insurance Dashboard: http://localhost:${PORT}`);
});

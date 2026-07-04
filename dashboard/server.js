import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.DASHBOARD_PORT || 3456;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

app.use(express.json());

function extractMobileFromRemarks(remarks) {
  if (!remarks) return '';
  const m = remarks.match(/\[Mobile:\s*(\S+)\]/);
  return m ? m[1] : '';
}
function sanitizeRemarks(remarks) {
  if (!remarks) return '';
  return remarks.replace(/\[Mobile:\s*\S+\]\s*/g, '').trim();
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/call-center', (req, res) => {
  res.sendFile(path.join(__dirname, 'call-center.html'));
});

app.get('/performance', (req, res) => {
  res.sendFile(path.join(__dirname, 'performance.html'));
});

app.use(express.static(path.join(__dirname)));

async function logDbActivity(token, action, page, details) {
  const session = authTokens.get(token);
  if (!session) return;
  const entry = { user_id: session.userId, username: session.username, action, page: page || '', details: details || {}, created_at: new Date().toISOString() };
  // Try Supabase first
  try {
    await supabase.from('auth_activities').insert(entry);
  } catch (_) {}
  // Always write to file as fallback
  const db = readAuth();
  entry.id = db.activities.length + 1;
  db.activities.push(entry);
  writeAuth(db);
}

// ── Auth (file-based store) ──────────────────────────────
const AUTH_FILE = path.join(__dirname, 'auth-data.json');
function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return { users: [], activities: [], nextId: 1 }; }
}
function writeAuth(d) { fs.writeFileSync(AUTH_FILE, JSON.stringify(d, null, 2)); }

const authTokens = new Map();
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24h

function hashPw(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

// POST /api/auth/setup — create/ensure default admin
app.post('/api/auth/setup', async (req, res) => {
  try {
    const db = readAuth();
    const { force } = req.body || {};
    if (force) { db.users = []; db.activities = []; db.nextId = 1; }
    const existing = db.users.find(u => u.username === 'admin');
    if (existing) {
      existing.password = hashPw('admin123');
      writeAuth(db);
      return res.json({ success: true, message: 'Admin password reset (admin / admin123)' });
    }
    db.users.push({ id: db.nextId++, username: 'admin', password: hashPw('admin123'), role: 'admin', created_at: new Date().toISOString() });
    writeAuth(db);
    res.json({ success: true, message: 'Default admin created (admin / admin123)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const db = readAuth();
    const user = db.users.find(u => u.username === username);
    if (!user || user.password !== hashPw(password)) return res.status(401).json({ error: 'Invalid credentials' });
    const token = genToken();
    const tokenData = { userId: user.id, username: user.username, role: user.role, expiry: Date.now() + TOKEN_TTL };
    authTokens.set(token, tokenData);
    persistToken(token, tokenData);
    await logDbActivity(token, 'login', 'landing');
    res.json({ success: true, token, user: { username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/verify
app.post('/api/auth/verify', (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ valid: false });
  const session = authTokens.get(token);
  if (!session || session.expiry < Date.now()) {
    authTokens.delete(token);
    // Attempt file-based recovery: re-create session if token matches stored token for a user
    try {
      const tokensFile = path.join(__dirname, 'auth-tokens.json');
      if (fs.existsSync(tokensFile)) {
        const stored = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
        const entry = stored.tokens?.[token];
        if (entry && entry.expiry > Date.now()) {
          authTokens.set(token, { userId: entry.userId, username: entry.username, role: entry.role, expiry: entry.expiry });
          return res.json({ valid: true, user: { username: entry.username, role: entry.role } });
        }
      }
    } catch (_) {}
    return res.json({ valid: false });
  }
  res.json({ valid: true, user: { username: session.username, role: session.role } });
});

function persistToken(token, session) {
  try {
    const tokensFile = path.join(__dirname, 'auth-tokens.json');
    const stored = fs.existsSync(tokensFile) ? JSON.parse(fs.readFileSync(tokensFile, 'utf8')) : { tokens: {} };
    stored.tokens[token] = session;
    fs.writeFileSync(tokensFile, JSON.stringify(stored, null, 2));
  } catch (_) {}
}

// POST /api/auth/log-activity
app.post('/api/auth/log-activity', async (req, res) => {
  try {
    const { token, action, page, details } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const session = authTokens.get(token);
    if (!session) return res.status(401).json({ error: 'Invalid token' });
    await logDbActivity(token, action || 'view', page, details);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { token, currentPassword, newPassword } = req.body;
    if (!token || !currentPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'Password min 4 characters' });
    const session = authTokens.get(token);
    if (!session) return res.status(401).json({ error: 'Invalid token' });
    const db = readAuth();
    const user = db.users.find(u => u.id === session.userId);
    if (!user || user.password !== hashPw(currentPassword)) return res.status(401).json({ error: 'Current password incorrect' });
    user.password = hashPw(newPassword);
    await logDbActivity(token, 'change_password');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin endpoints ──────────────────────────────────────
function adminGuard(req, res) {
  const token = req.body?.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = authTokens.get(token);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  return session;
}

// POST /api/auth/admin/users
app.post('/api/auth/admin/users', async (req, res) => {
  const session = adminGuard(req, res);
  if (!session) return;
  const db = readAuth();
  res.json({ users: db.users.map(u => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at })) });
});

// POST /api/auth/admin/create-user
app.post('/api/auth/admin/create-user', async (req, res) => {
  const session = adminGuard(req, res);
  if (!session) return;
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const db = readAuth();
    if (db.users.find(u => u.username === username)) return res.status(400).json({ error: 'Username already exists' });
    db.users.push({ id: db.nextId++, username, password: hashPw(password), role: role || 'user', created_at: new Date().toISOString() });
    await logDbActivity(req.body.token, 'admin_create_user', '', { target: username });
    writeAuth(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/admin/reset-password
app.post('/api/auth/admin/reset-password', async (req, res) => {
  const session = adminGuard(req, res);
  if (!session) return;
  try {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword) return res.status(400).json({ error: 'userId and newPassword required' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'Password min 4 characters' });
    const db = readAuth();
    const user = db.users.find(u => u.id === Number(userId));
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.password = hashPw(newPassword);
    await logDbActivity(req.body.token, 'admin_reset_password', '', { target: user.username, target_id: userId });
    writeAuth(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/admin/update-username
app.post('/api/auth/admin/update-username', async (req, res) => {
  const session = adminGuard(req, res);
  if (!session) return;
  try {
    const { userId, newUsername } = req.body;
    if (!userId || !newUsername) return res.status(400).json({ error: 'userId and newUsername required' });
    const db = readAuth();
    if (db.users.find(u => u.username === newUsername)) return res.status(400).json({ error: 'Username already taken' });
    const user = db.users.find(u => u.id === Number(userId));
    if (!user) return res.status(404).json({ error: 'User not found' });
    const old = user.username;
    user.username = newUsername;
    await logDbActivity(req.body.token, 'admin_update_username', '', { from: old, to: newUsername, target_id: userId });
    writeAuth(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/admin/delete-user
app.post('/api/auth/admin/delete-user', async (req, res) => {
  const session = adminGuard(req, res);
  if (!session) return;
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (Number(userId) === session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    const db = readAuth();
    const idx = db.users.findIndex(u => u.id === Number(userId));
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    const u = db.users[idx];
    db.users.splice(idx, 1);
    await logDbActivity(req.body.token, 'admin_delete_user', '', { target: u.username, target_id: userId });
    writeAuth(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/admin/activity
app.post('/api/auth/admin/activity', async (req, res) => {
  const session = adminGuard(req, res);
  if (!session) return;
  const db = readAuth();
  const activities = db.activities.slice().reverse().slice(0, 200);
  res.json({ activities });
});

async function fetchAll(table) {
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    const result = await Promise.race([
      supabase.from(table).select('*').range(from, from + size - 1),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Supabase query timed out after 8s')), 8000))
    ]);
    const { data, error } = result;
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    from += size;
    if (data.length < size) break;
  }
  return all;
}

function parseDateForFilter(dateStr) {
  if (!dateStr) return null;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [d, m, y] = dateStr.split('/');
    return `${y}-${m.padStart(2, '0')}`;
  }
  const m = dateStr.match(/(\d{2})\s+(\w+)\s+(\d{4})/);
  if (m) {
    const months = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
    const monthNum = months[m[2]];
    if (monthNum) return `${m[3]}-${String(monthNum).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}/.test(dateStr)) return dateStr.substring(0, 7);
  return null;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/call-center', (req, res) => {
  res.sendFile(path.join(__dirname, 'call-center.html'));
});

app.post('/api/refresh', async (req, res) => {
  try {
    const sql = `REFRESH MATERIALIZED VIEW CONCURRENTLY workshop_performance_jc_summary_v1; REFRESH MATERIALIZED VIEW CONCURRENTLY workshop_operation_addon_summary_v1;`;
    const r = await fetch(`${SUPABASE_URL}/pg-meta/v1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ query: sql })
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(t.substring(0, 200));
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data', async (req, res) => {
  try {
    const rows = await fetchAll('kia_insurance');
    res.json({ rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/renewal-analysis', async (req, res) => {
  try {
    const rows = await fetchAll('kia_insurance');
    const valid = rows.filter(r => r.vinno && r.create_date);
    const yearMap = {};
    for (const r of valid) {
      const yr = r.create_date.substring(0, 4);
      if (!yearMap[yr]) yearMap[yr] = new Set();
      yearMap[yr].add(r.vinno);
    }
    const years = Object.keys(yearMap).sort();
    const analysis = [];
    const allPrevVins = new Set();
    for (const yr of years) {
      const currentVins = yearMap[yr];
      const prevYear = String(Number(yr) - 1);
      const prevVins = yearMap[prevYear] || new Set();
      const rollover = [...currentVins].filter(v => prevVins.has(v));
      const renewal = [...currentVins].filter(v => !prevVins.has(v) && allPrevVins.has(v));
      const newCustomers = [...currentVins].filter(v => !prevVins.has(v) && !allPrevVins.has(v));
      const lapsed = [...prevVins].filter(v => !currentVins.has(v));
      analysis.push({
        year: yr,
        total: currentVins.size,
        rollover, rolloverCount: rollover.length,
        renewal, renewalCount: renewal.length,
        newCustomers, newCustomersCount: newCustomers.length,
        lapsed, lapsedCount: lapsed.length
      });
      currentVins.forEach(v => allPrevVins.add(v));
    }
    res.json({ analysis, totalVins: new Set(valid.map(r => r.vinno)).size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/renewal-detail', async (req, res) => {
  try {
    const rows = await fetchAll('kia_insurance');
    const valid = rows.filter(r => r.vinno && r.create_date);
    const vinLatest = {};
    for (const r of valid) {
      const key = r.vinno;
      if (!vinLatest[key] || r.create_date > vinLatest[key].create_date) {
        vinLatest[key] = r;
      }
    }
    const vinMonths = {};
    for (const r of valid) {
      if (!vinMonths[r.vinno]) vinMonths[r.vinno] = new Set();
      vinMonths[r.vinno].add(r.create_date.substring(0, 7));
    }
    const today = new Date();
    const currentYm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const detail = [];
    for (const [vin, monthsSet] of Object.entries(vinMonths)) {
      const sortedMonths = [...monthsSet].sort();
      const lastMonth = sortedMonths[sortedMonths.length - 1];
      const [ly, lm] = lastMonth.split('-').map(Number);
      const expectedRenewalYm = `${ly + 1}-${String(lm).padStart(2, '0')}`;
      const lastRecord = vinLatest[vin];
      const isOverdue = expectedRenewalYm < currentYm;
      let status = 'Current';
      if (sortedMonths.length === 1) status = 'New';
      else if (isOverdue) status = 'Overdue';
      else status = 'Active';
      detail.push({
        vin, customer: lastRecord.customer_name || '-',
        model: lastRecord.model || '-',
        policyNo: lastRecord.policyno || '-',
        lastInsurance: lastRecord.insurancecompany || '-',
        lastPremium: Number(lastRecord.grosspremium) || 0,
        lastDate: lastRecord.create_date,
        monthsActive: sortedMonths.length,
        firstSeen: sortedMonths[0],
        lastSeen: lastMonth, status
      });
    }
    detail.sort((a, b) => {
      const order = { Overdue: 0, New: 1, Active: 2, Current: 3 };
      return (order[a.status] || 9) - (order[b.status] || 9);
    });
    res.json({
      detail,
      summary: {
        total: detail.length,
        overdue: detail.filter(d => d.status === 'Overdue').length,
        new: detail.filter(d => d.status === 'New').length,
        active: detail.filter(d => d.status === 'Active').length,
        current: detail.filter(d => d.status === 'Current').length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/call-center/due', async (req, res) => {
  try {
    const month = req.query.month || (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    const rows = await fetchAll('kia_insurance');

    // Parse selected month → look at last year same month
    const [selYear, selMonth] = month.split('-').map(Number);
    const lastYear = selYear - 1;
    const lastYearMonthPrefix = `${lastYear}-${String(selMonth).padStart(2, '0')}`;
    const currentYearPrefix = String(selYear);

    // Index VINs by year
    const vinsByYear = {};
    for (const r of rows) {
      if (!r.vinno || !r.create_date) continue;
      const yr = r.create_date.substring(0, 4);
      if (!vinsByYear[yr]) vinsByYear[yr] = new Set();
      vinsByYear[yr].add(r.vinno);
    }

    // Latest record per VIN for last year's month (exclude cancelled)
    const candidateVins = new Set();
    const vinLatest = {};
    for (const r of rows) {
      if (!r.vinno || !r.create_date) continue;
      if (r.cancelled === 'Yes') continue;
      if (!r.create_date.startsWith(lastYearMonthPrefix)) continue;
      candidateVins.add(r.vinno);
      if (!vinLatest[r.vinno] || r.create_date > vinLatest[r.vinno].create_date) {
        vinLatest[r.vinno] = r;
      }
    }

    // Filter: present in last year's month but NOT in current year
    const currentYearVins = vinsByYear[currentYearPrefix] || new Set();
    const pendingVins = [...candidateVins].filter(v => !currentYearVins.has(v));

    // Fetch call logs
    let allLogs = [];
    try { allLogs = await fetchAll('call_logs'); } catch (_) {}
    const logMap = {}, logCount = {}, logsByPolicy = {};
    for (const log of allLogs) {
      const key = log.policyno;
      if (!logMap[key] || log.call_date > logMap[key].call_date) logMap[key] = log;
      logCount[key] = (logCount[key] || 0) + 1;
      if (!logsByPolicy[key]) logsByPolicy[key] = [];
      logsByPolicy[key].push(log);
    }
    for (const key of Object.keys(logsByPolicy)) {
      logsByPolicy[key].sort((a,b)=>new Date(b.call_date)-new Date(a.call_date));
    }

    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthName = months[selMonth - 1];
    const due = [];

    for (const vin of pendingVins) {
      const r = vinLatest[vin];
      if (!r) continue;
      const pno = r.policyno || '';
      const lastLog = logMap[pno];
      const history = (logsByPolicy[pno] || []).map(l => ({
        outcome: l.call_outcome, date: l.call_date,
        agent: l.agent_name, remarks: l.remarks, follow_up: l.follow_up_date
      }));
      due.push({
        policyno: pno,
        vinno: r.vinno || '',
        customer_name: r.customer_name || '-',
        model: r.model || '-',
        insurancecompany: r.insurancecompany || '-',
        grosspremium: Number(r.grosspremium) || 0,
        policy_expiry_date: r.create_date || '',
        policy_effective_date: r.policy_effective_date || '',
        state: r.state || '',
        location: r.location || '',
        dealer: r.dealer || '',
        mobile: lastLog ? (lastLog.mobile_no || extractMobileFromRemarks(lastLog.remarks || '')) : '',
        create_date: r.create_date || '',
        call_status: lastLog ? lastLog.call_outcome : 'Pending',
        last_call_date: lastLog ? lastLog.call_date : null,
        last_remarks: lastLog ? sanitizeRemarks(lastLog.remarks || '') : '',
        last_agent: lastLog ? lastLog.agent_name : '',
        follow_up_date: lastLog ? lastLog.follow_up_date : null,
        log_id: lastLog ? lastLog.id : null,
        attempt_count: logCount[pno] || 0,
        history
      });
    }

    res.json({ due, total: due.length, month });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/call-center/logs', async (req, res) => {
  try {
    const { data, error } = await supabase.from('call_logs').select('*').order('call_date', { ascending: false });
    if (error) {
      if (error.message?.includes('relation') || error.code === '42P01') {
        return res.json({ logs: [] });
      }
      throw error;
    }
    res.json({ logs: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/call-center/log', async (req, res) => {
  try {
    const { policyno, vinno, customer_name, model, insurancecompany, grosspremium, policy_expiry_date, call_outcome, remarks, follow_up_date, agent_name, mobile_no } = req.body;
    if (!policyno || !call_outcome) {
      return res.status(400).json({ error: 'policyno and call_outcome are required' });
    }
    let { data, error } = await supabase.from('call_logs').insert({
      policyno, vinno, customer_name, model, insurancecompany,
      grosspremium: grosspremium ? Number(grosspremium) : null,
      policy_expiry_date, call_outcome, remarks, follow_up_date: follow_up_date || null,
      agent_name: agent_name || '',
      mobile_no: mobile_no || '',
      call_date: new Date().toISOString()
    }).select().single();
    if (error) {
      if (error.message?.includes('relation') || error.code === '42P01') {
        return res.status(400).json({
          error: 'call_logs table does not exist. Run create-call-logs-table.sql in Supabase SQL editor first.',
          sql: `CREATE TABLE IF NOT EXISTS call_logs (id BIGSERIAL PRIMARY KEY, policyno TEXT, vinno TEXT, customer_name TEXT, model TEXT, insurancecompany TEXT, grosspremium NUMERIC, policy_expiry_date TEXT, mobile_no TEXT, call_date TIMESTAMPTZ DEFAULT NOW(), call_outcome TEXT NOT NULL, remarks TEXT, follow_up_date DATE, agent_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`
        });
      }
      throw error;
    }
    res.json({ success: true, log: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger: fetch KIA Safety data (D-1 or custom date range)
app.post('/api/fetch-kia-data', async (req, res) => {
  const { token, from, to } = req.body || {};
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = authTokens.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid token' });

  // Count rows before fetch
  let countBefore = 0;
  try {
    const { count } = await supabase.from('insurance_kia').select('*', { count: 'exact', head: true });
    countBefore = count || 0;
  } catch (_) {}

  const cwd = path.join(__dirname, '..');
  const env = { ...process.env };
  if (from) env.KIA_SAFETY_FROM_DATE = from;
  if (to) env.KIA_SAFETY_TO_DATE = to;
  const timeout = from && to ? 600000 : 120000;

  execFile('node', ['src/cron/scheduler.js', '--once', '--mode=kia-safety-daily'], { cwd, timeout, shell: true, env }, async (error, stdout, stderr) => {
    if (error) {
      console.error('Fetch KIA data error:', error.message, 'stderr:', stderr?.substring(0, 1000));
      const msg = (error.message + ' ' + (stderr || '')).toLowerCase();
      const isUrlError = /err_|timeout|econnrefused|enotfound|navigation|net::|could not|failed to connect/i.test(msg);
      const errMsg = stderr ? stderr.split('\n').filter(l => l.includes('"msg"')).map(l => { try { return JSON.parse(l).msg; } catch { return null; } }).filter(Boolean).pop() || 'Command failed' : 'Command failed';
      return res.status(500).json({ urlError: !!isUrlError, error: errMsg });
    }

    // Count rows after fetch
    let countAfter = 0;
    try {
      const { count } = await supabase.from('insurance_kia').select('*', { count: 'exact', head: true });
      countAfter = count || 0;
    } catch (_) {}

    const insertedRowCount = countAfter - countBefore;
    res.json({ success: true, insertedRowCount: Math.max(0, insertedRowCount), duplicateRowCount: countBefore > 0 && insertedRowCount === 0 ? countAfter : -1 });
  });
});

// Admin: verify credentials and delete all KIA insurance data
app.post('/api/delete-all-kia-data', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const db = readAuth();
  const user = db.users.find(u => u.username === username && u.password === hashPw(password) && u.role === 'admin');
  if (!user) return res.status(403).json({ error: 'Invalid admin credentials' });
  try {
    const { error } = await supabase.from('insurance_kia').delete().neq('id', 0);
    if (error) return res.status(500).json({ error: 'Delete failed' });
    // Log to file directly
    const entry = { id: db.activities.length + 1, user_id: user.id, username: user.username, action: 'delete_all_kia_data', page: 'performance', details: {}, created_at: new Date().toISOString() };
    db.activities.push(entry);
    writeAuth(db);
    try { await supabase.from('auth_activities').insert({ user_id: user.id, username: user.username, action: 'delete_all_kia_data', page: 'performance', details: {}, created_at: new Date().toISOString() }); } catch (_) {}
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});

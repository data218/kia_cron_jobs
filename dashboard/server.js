import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function ensureCallLogsTable() {
  const sql = `CREATE TABLE IF NOT EXISTS call_logs (
    id BIGSERIAL PRIMARY KEY, policyno TEXT, vinno TEXT, customer_name TEXT,
    model TEXT, insurancecompany TEXT, grosspremium NUMERIC,
    policy_expiry_date TEXT, mobile_no TEXT,
    call_date TIMESTAMPTZ DEFAULT NOW(),
    call_outcome TEXT NOT NULL, remarks TEXT, follow_up_date DATE,
    agent_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  try {
    const res = await fetch(`${SUPABASE_URL}/pg-meta/v1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ query: sql })
    });
    if (res.ok) { console.log('call_logs table ready'); return; }
    const t = await res.text();
    console.warn('pg-meta query failed:', res.status, t.substring(0,200));
  } catch (_) {}
  try {
    const { error } = await supabase.from('call_logs').select('id').limit(1);
    if (!error) {
      console.log('call_logs table already exists');
      try {
        await fetch(`${SUPABASE_URL}/pg-meta/v1/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          body: JSON.stringify({ query: `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS mobile_no TEXT;` })
        });
      } catch (_) {}
      return;
    }
  } catch (_) {}
  console.warn('call_logs table not found. Run the SQL from create-call-logs-table.sql in Supabase SQL editor.');
}
ensureCallLogsTable();

async function fetchAll(table) {
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + size - 1);
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
    const [y, m] = month.split('-').map(Number);
    const monthName = months[m - 1];
    const due = [];
    for (const r of rows) {
      // Filter by create_date month (since policy_expiry_date is not available)
      if (!r.create_date) continue;
      const cd = r.create_date;
      let match = false;
      if (cd.startsWith(`${y}-${String(m).padStart(2, '0')}`)) match = true;
      if (!match) continue;
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
        policy_effective_date: '',
        state: r.state || '',
        location: r.location || '',
        dealer: r.dealer || '',
        mobile: lastLog ? (lastLog.mobile_no || extractMobileFromRemarks(lastLog.remarks || '')) : '',
        create_date: r.create_date || '',
        policy_effective_date: r.policy_effective_date || '',
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
          error: 'call_logs table does not exist. Run the SQL from create-call-logs-table.sql in Supabase SQL editor first.',
          sql: `CREATE TABLE IF NOT EXISTS call_logs (id BIGSERIAL PRIMARY KEY, policyno TEXT, vinno TEXT, customer_name TEXT, model TEXT, insurancecompany TEXT, grosspremium NUMERIC, policy_expiry_date TEXT, mobile_no TEXT, call_date TIMESTAMPTZ DEFAULT NOW(), call_outcome TEXT NOT NULL, remarks TEXT, follow_up_date DATE, agent_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`
        });
      }
      if (error.message?.includes('mobile_no')) {
        // mobile_no column doesn't exist — embed mobile into remarks
        const mergedRemarks = mobile_no ? `[Mobile: ${mobile_no}] ${remarks || ''}`.trim() : (remarks || '');
        const { data: d2, error: e2 } = await supabase.from('call_logs').insert({
          policyno, vinno, customer_name, model, insurancecompany,
          grosspremium: grosspremium ? Number(grosspremium) : null,
          policy_expiry_date, call_outcome, remarks: mergedRemarks, follow_up_date: follow_up_date || null,
          agent_name: agent_name || '',
          call_date: new Date().toISOString()
        }).select().single();
        if (e2) throw e2;
        return res.json({ success: true, log: d2 });
      }
      throw error;
    }
    res.json({ success: true, log: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});

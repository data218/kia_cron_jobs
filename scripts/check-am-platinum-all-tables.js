import 'dotenv/config';
import { Client } from 'pg';
import { config } from '../src/config.js';

const client = new Client({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false }
});

async function getTableColumns(tableName) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tableName]
  );
  return res.rows.map(r => r.column_name);
}

function guessDateColumn(columns) {
  const col = columns.map(c => c.toLowerCase());
  const priority = [
    'report_period_start',
    'bill_date',
    'ro_date',
    'complaint_date',
    'appointment_date',
    'appointement_date',
    'booking_date',
    'reg_date',
    'registration_date',
    'purchase_date',
    'invoice_date',
    'package_purchase_date',
    'created_at',
    'uploaded_at'
  ];
  for (const p of priority) {
    const idx = col.indexOf(p);
    if (idx >= 0) return columns[idx];
  }
  return null;
}

const tables = [
  { table: 'am_platinum_repair_order_list', reportId: 'hyundai-repair-order-list' },
  { table: 'am_platinum_ro_billing_report', reportId: 'hyundai-ro-billing-report' },
  { table: 'am_platinum_call_center_complaints', reportId: 'hyundai-call-center-complaints' },
  { table: 'am_platinum_customer_complaint_list', reportId: 'hyundai-customer-complaint-list' },
  { table: 'am_platinum_open_ro_yearly', reportId: 'hyundai-open-ro-yearly' },
  { table: 'am_platinum_demo_job_cards', reportId: 'hyundai-demo-job-cards' },
  { table: 'am_platinum_demo_car_list', reportId: 'hyundai-demo-car-list' },
  { table: 'am_platinum_service_appointment', reportId: 'hyundai-service-appointment' },
  { table: 'am_platinum_trust_package', reportId: 'hyundai-trust-package-bodyshop-sot' },
  { table: 'am_platinum_psf_yearly', reportId: 'hyundai-psf-yearly' },
  { table: 'am_platinum_ew_report', reportId: 'hyundai-ew-report' },
  { table: 'am_platinum_mcp_report', reportId: 'hyundai-mcp-report' },
  { table: 'am_platinum_adv_wise_lubricants_vas', reportId: 'hyundai-adv-wise-lubricants-vas' },
  { table: 'am_platinum_operation_wise_analysis_report', reportId: 'hyundai-operation-wise-analysis-report' }
];

async function main() {
  await client.connect();

  console.log('');
  console.log('═'.repeat(80));
  console.log('  AM Platinum Table Coverage Analysis (Jan 2021 → Today)');
  console.log('═'.repeat(80));
  console.log('');
  console.log(`  Target date range: 2021-01-01 → ${new Date().toISOString().slice(0, 10)}`);
  console.log(`  Dealers: ${config.amPlatinumDealerCodes.join(', ') || 'active'}`);
  console.log('');

  const results = [];

  for (const { table, reportId } of tables) {
    try {
      const columns = await getTableColumns(table);
      const dateCol = guessDateColumn(columns);

      if (!dateCol) {
        const cntRes = await client.query(`SELECT COUNT(*)::int as cnt FROM public."${table}"`);
        const cnt = cntRes.rows[0].cnt;
        results.push({
          table,
          reportId,
          status: 'partial_or_latest',
          rowCount: cnt,
          hasDate: false,
          note: 'no recognizable date column'
        });
        console.log(`⚠️  NO DATE    ${table}`);
        console.log(`             rows=${cnt}, columns=${columns.join(', ')}\n`);
        continue;
      }

      const res = await client.query(
        `SELECT COUNT(*)::int as cnt, MIN("${dateCol}") as min_val, MAX("${dateCol}") as max_val FROM public."${table}"`
      );
      const row = res.rows[0];
      const cnt = row.cnt;
      const hasFull = row.min_val <= '2021-01-01' && row.max_val >= '2026-06-01';
      const hasAny = cnt > 0;

      if (hasFull && hasAny) {
        results.push({ table, reportId, status: 'full', rowCount: cnt, hasDate: true });
        console.log(`✅ FULL       ${table}`);
        console.log(`             rows=${cnt} (${dateCol}: ${row.min_val} → ${row.max_val})\n`);
      } else if (hasAny) {
        results.push({ table, reportId, status: 'partial_or_latest', rowCount: cnt, hasDate: true });
        console.log(`⚠️  PARTIAL    ${table}`);
        console.log(`             rows=${cnt} (${dateCol}: ${row.min_val} → ${row.max_val})\n`);
      } else {
        results.push({ table, reportId, status: 'missing', rowCount: 0, hasDate: true });
        console.log(`❌ EMPTY      ${table}`);
        console.log(`             rows=0 (${dateCol}: ${row.min_val} → ${row.max_val})\n`);
      }
    } catch (e) {
      results.push({ table, reportId, status: 'missing', rowCount: 0, note: e.message });
      console.log(`❌ MISSING    ${table}`);
      console.log(`             ${e.message}\n`);
    }
  }

  const full = results.filter(r => r.status === 'full');
  const needsWork = results.filter(r => r.status !== 'full');

  console.log('═'.repeat(80));
  console.log('  SUMMARY');
  console.log('═'.repeat(80));
  console.log(`  Full coverage : ${full.length}/${results.length} tables (skip)`);
  console.log(`  Needs backfill: ${needsWork.length}/${results.length} tables`);
  console.log('');

  if (needsWork.length > 0) {
    console.log('  Reports to run (each in its own visible browser):\n');
    console.log(`  seq  | reportId                              | table                                | status`);
    console.log(`  -----|---------------------------------------|--------------------------------------|----------`);
    needsWork.forEach((r, i) => {
      const pad = (s, n) => s.padEnd(n).slice(0, n);
      console.log(`  ${String(i + 1).padStart(3)}   | ${pad(r.reportId, 40)} | ${pad(r.table, 37)} | ${pad(r.status, 9)}`);
    });
    console.log('');
  }

  await client.end();
}

main().catch((error) => {
  console.error('Failed:', error);
  process.exitCode = 1;
});

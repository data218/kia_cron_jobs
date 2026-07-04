// ============================================================
//  backfill-hyundai-op-wise-clean.js
//
//  CLEAN SLATE BACKFILL — Operation Wise Analysis Report
//  Jan 2021 → Today, both accounts, NO deduplication, NO remap
//
//  Phase 1 — sahiltech:  N5203, N5701, N5804, N6815, N6819, N6826
//  Phase 2 — MIS5216:    N5216, N6844, N6845, N6846, N6847, N6848
//
//  Usage:
//    node --env-file=.env scripts/backfill-hyundai-op-wise-clean.js
// ============================================================

process.env.HMIL_USER_ID               = 'sahiltech';
process.env.HMIL_PASSWORD              = 'Amgroup@321';
process.env.HMIL_SECONDARY_USER_ID     = 'MIS5216';
process.env.HMIL_SECONDARY_PASSWORD    = 'Singh@321';
process.env.HMIL_SESSION_STATE_PATH    = './storage/hmil-primary-dms-state.json';

process.env.HMIL_HISTORICAL_START_DATE    = '2021-01-01';
process.env.HMIL_HISTORICAL_END_DATE      = new Date().toISOString().split('T')[0];
process.env.HMIL_HISTORICAL_REPORTS       = 'hyundai-operation-wise-analysis-report';
process.env.HMIL_HISTORICAL_HEADLESS      = process.env.HMIL_HISTORICAL_HEADLESS || 'true';
process.env.HMIL_HISTORICAL_OTP_PROVIDER  = 'webhook';
process.env.HMIL_HISTORICAL_RESUME_FROM_STATE = 'true';
process.env.HMIL_HISTORICAL_STOP_ON_FAILURE   = 'false';
process.env.HMIL_HISTORICAL_SKIP_EXISTING     = 'false'; // re-fetch everything fresh

import { promises as fsp } from 'node:fs';
import path from 'node:path';

const { config } = await import('../src/config.js');
const { withPostgresClient } = await import('../src/supabase/postgres.js');
const { runGdmsReportFirstHistoricalBackfill } = await import('./hmil-report-first-historical-runner.js');

// ── Correct dealer lists per account ──────────────────────────────────────────
const primaryDealers   = ['N5203', 'N5701', 'N5804', 'N6815', 'N6819', 'N6826']; // sahiltech
const secondaryDealers = ['N5216', 'N6844', 'N6845', 'N6846', 'N6847', 'N6848']; // MIS5216

const logsDir           = config.logsDir || './logs';
const primaryStateFile  = 'hmil-primary-op-wise-clean-state.json';
const secondaryStateFile = 'hmil-secondary-op-wise-clean-state.json';

console.log('='.repeat(72));
console.log('  HMIL Op-Wise Clean Backfill — Jan 2021 → Today (Both Accounts)');
console.log('='.repeat(72));
console.log(`  Phase 1  sahiltech  : ${primaryDealers.join(', ')}`);
console.log(`  Phase 2  MIS5216    : ${secondaryDealers.join(', ')}`);
console.log(`  Start    : ${process.env.HMIL_HISTORICAL_START_DATE}`);
console.log(`  End      : ${process.env.HMIL_HISTORICAL_END_DATE}`);
console.log(`  Dedup    : DISABLED`);
console.log(`  Remap    : DISABLED`);
console.log('='.repeat(72));

// ── Step 1: Delete ALL existing data from the table ───────────────────────────
console.log('\n🗑️  Step 1: Deleting all existing data from hyundai_operation_wise_analysis_report...');
await withPostgresClient(async client => {
  const result = await client.query('DELETE FROM public.hyundai_operation_wise_analysis_report');
  console.log(`   Deleted ${result.rowCount} rows.`);
});
console.log('   Table is now empty.\n');

// ── Step 2: Clear state files so we start fresh ───────────────────────────────
await fsp.unlink(path.join(logsDir, primaryStateFile)).catch(() => {});
await fsp.unlink(path.join(logsDir, secondaryStateFile)).catch(() => {});
console.log('🔄 Step 2: Cleared state files — starting fresh runs.\n');

// ── Phase 1: sahiltech → N5203, N5701, N5804, N6815, N6819, N6826 ─────────────
console.log('='.repeat(72));
console.log(`▶  PHASE 1: sahiltech → ${primaryDealers.join(', ')}`);
console.log('='.repeat(72));
process.env.HMIL_HISTORICAL_DEALERS = primaryDealers.join(',');

let phase1Success = false;
try {
  await runGdmsReportFirstHistoricalBackfill({
    accountId:     'hmil',
    envPrefix:     'HMIL',
    stateFileName: primaryStateFile,
    logFilePrefix: 'hmil-primary-op-wise-clean',
    serviceName:   'hmil-primary-op-wise-clean'
  });
  console.log('\n✅ Phase 1 completed successfully.');
  phase1Success = true;
} catch (err) {
  console.error('\n❌ Phase 1 failed:', err.message);
}

// ── Phase 2: MIS5216 → N5216, N6844, N6845, N6846, N6847, N6848 ──────────────
console.log('\n' + '='.repeat(72));
console.log(`▶  PHASE 2: MIS5216 → ${secondaryDealers.join(', ')}`);
console.log('='.repeat(72));
process.env.HMIL_HISTORICAL_DEALERS = secondaryDealers.join(',');

let phase2Success = false;
try {
  await runGdmsReportFirstHistoricalBackfill({
    accountId:     'hmil-secondary',
    envPrefix:     'HMIL',
    stateFileName: secondaryStateFile,
    logFilePrefix: 'hmil-secondary-op-wise-clean',
    serviceName:   'hmil-secondary-op-wise-clean'
  });
  console.log('\n✅ Phase 2 completed successfully.');
  phase2Success = true;
} catch (err) {
  console.error('\n❌ Phase 2 failed:', err.message);
}

// ── Final summary ─────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(72));
console.log('  FINAL SUMMARY');
console.log('='.repeat(72));
console.log(`  Phase 1 (sahiltech / ${primaryDealers.join(', ')})   : ${phase1Success ? '✅ SUCCESS' : '❌ FAILED'}`);
console.log(`  Phase 2 (MIS5216   / ${secondaryDealers.join(', ')}) : ${phase2Success ? '✅ SUCCESS' : '❌ FAILED'}`);
console.log(`  Deduplication  : SKIPPED (not needed)`);
console.log(`  Dealer remap   : SKIPPED (data stored under original codes)`);

await withPostgresClient(async client => {
  const result = await client.query(`
    SELECT dealer_code, COUNT(*) as rows,
           COUNT(DISTINCT TO_CHAR(report_month::date,'YYYY-MM')) as months
    FROM public.hyundai_operation_wise_analysis_report
    GROUP BY dealer_code ORDER BY dealer_code
  `);
  console.log('\n  Final row counts in DB:');
  result.rows.forEach(r => console.log(`    ${r.dealer_code}  :  ${r.rows} rows  (${r.months} months)`));
});

console.log('\n  Finished at:', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 'IST');
console.log('='.repeat(72));

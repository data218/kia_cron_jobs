// ============================================================
//  resume-hmil-op-wise-n6828.js
//  Runs Operation-Wise Analysis Report backfill for N6828 only
//  using the primary account (sahiltech).
//
//  N6828 was the only dealer that failed in Phase 1 because
//  the dealer search popup didn't show it. This script retries
//  it with a fresh dedicated state file.
//
//  Usage:
//    node --env-file=.env scripts/resume-hmil-op-wise-n6828.js
// ============================================================

// Setup environment variables BEFORE importing config or runner
process.env.HMIL_USER_ID               = 'sahiltech';
process.env.HMIL_PASSWORD              = 'Amgroup@321';
process.env.HMIL_SESSION_STATE_PATH    = './storage/hmil-primary-dms-state.json';

process.env.HMIL_HISTORICAL_START_DATE    = '2021-01-01';
process.env.HMIL_HISTORICAL_END_DATE      = new Date().toISOString().split('T')[0];
process.env.HMIL_HISTORICAL_REPORTS       = 'hyundai-operation-wise-analysis-report';
process.env.HMIL_HISTORICAL_DEALERS       = 'N6828';
process.env.HMIL_HISTORICAL_HEADLESS      = process.env.HMIL_HISTORICAL_HEADLESS || 'true';
process.env.HMIL_HISTORICAL_OTP_PROVIDER  = 'webhook';
process.env.HMIL_HISTORICAL_RESUME_FROM_STATE = 'true';
process.env.HMIL_HISTORICAL_STOP_ON_FAILURE   = 'false';
process.env.HMIL_HISTORICAL_SKIP_EXISTING     = 'true';

import { promises as fsp } from 'node:fs';
import path from 'node:path';

const { config }  = await import('../src/config.js');
const { runGdmsReportFirstHistoricalBackfill } = await import('./hmil-report-first-historical-runner.js');

const logsDir     = config.logsDir || './logs';
const stateFile   = 'hmil-primary-op-wise-n6828-state.json';

// Always start fresh for N6828 (it never completed before)
await fsp.unlink(path.join(logsDir, stateFile)).catch(() => {});
console.log('Cleared any previous N6828 state file.');

console.log('='.repeat(72));
console.log('  HMIL Op-Wise Backfill — N6828 only (sahiltech / Phase 1 resume)');
console.log('='.repeat(72));
console.log(`  Start Date : ${process.env.HMIL_HISTORICAL_START_DATE}`);
console.log(`  End Date   : ${process.env.HMIL_HISTORICAL_END_DATE}`);
console.log(`  Dealer     : N6828`);
console.log(`  Account    : sahiltech (primary)`);
console.log(`  OTP        : webhook (automatic)`);
console.log(`  Headless   : ${process.env.HMIL_HISTORICAL_HEADLESS}`);
console.log('='.repeat(72) + '\n');

let success = false;

try {
  await runGdmsReportFirstHistoricalBackfill({
    accountId:      'hmil',
    envPrefix:      'HMIL',
    stateFileName:  stateFile,
    logFilePrefix:  'hmil-primary-op-wise-n6828',
    serviceName:    'hmil-primary-op-wise-n6828'
  });
  console.log('\n✅ N6828 backfill completed successfully.');
  success = true;
} catch (error) {
  console.error('\n❌ N6828 backfill failed:', error.message);
}

// ── Post-run: remap dealer code N6828 → N6848 and deduplicate ──────────────
if (success) {
  console.log('\n' + '='.repeat(72));
  console.log('  Running Post-Backfill: dealer code remap + deduplication');
  console.log('='.repeat(72));

  try {
    const { withPostgresClient } = await import('../src/supabase/postgres.js');

    await withPostgresClient(async client => {
      // Remap N6828 → N6848 in dealer_code column
      const r1 = await client.query(`
        UPDATE public.hyundai_operation_wise_analysis_report
        SET dealer_code = 'N6848'
        WHERE dealer_code = 'N6828'
      `);
      console.log(`  dealer_code remap N6828 → N6848: ${r1.rowCount} rows updated`);

      // Remap N6828 → N6848 in source_dealer_code column
      const r2 = await client.query(`
        UPDATE public.hyundai_operation_wise_analysis_report
        SET source_dealer_code = 'N6848'
        WHERE source_dealer_code = 'N6828'
      `);
      console.log(`  source_dealer_code remap N6828 → N6848: ${r2.rowCount} rows updated`);

      // Deduplicate
      console.log('\n  Running deduplication...');
      const { dedupeRelationalTables } = await import('../src/supabase/dedupe-relational-tables.js');
      await dedupeRelationalTables({
        tables: ['hyundai_operation_wise_analysis_report'],
        dryRun: false
      });
      console.log('  Deduplication complete.');
    });

    console.log('\n✅ Post-backfill migration and deduplication done.');
  } catch (err) {
    console.error('\n❌ Post-backfill migration failed:', err.message);
  }
}

console.log('\n' + '='.repeat(72));
console.log('  N6828 backfill run finished at:', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 'IST');
console.log('='.repeat(72));

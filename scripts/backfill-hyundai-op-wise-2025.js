// Setup environment variables BEFORE importing configuration or runner
process.env.HMIL_USER_ID = 'sahiltech';
process.env.HMIL_PASSWORD = 'Amgroup@321';
process.env.HMIL_SECONDARY_USER_ID = 'MIS5216';
process.env.HMIL_SECONDARY_PASSWORD = 'Singh@321';
process.env.HMIL_SESSION_STATE_PATH = './storage/hmil-primary-dms-state.json';

process.env.HMIL_HISTORICAL_START_DATE = '2021-01-01';
process.env.HMIL_HISTORICAL_END_DATE = new Date().toISOString().split('T')[0];
process.env.HMIL_HISTORICAL_REPORTS = 'hyundai-operation-wise-analysis-report';
process.env.HMIL_HISTORICAL_HEADLESS = process.env.HMIL_HISTORICAL_HEADLESS || 'true';
process.env.HMIL_HISTORICAL_OTP_PROVIDER = 'webhook';
process.env.HMIL_HISTORICAL_RESUME_FROM_STATE = 'true';
process.env.HMIL_HISTORICAL_STOP_ON_FAILURE = 'false';
process.env.HMIL_HISTORICAL_SKIP_EXISTING = 'true';

import { promises as fsp } from 'node:fs';
import path from 'node:path';
const { config } = await import('../src/config.js');

const primaryDealers = ['N5203', 'N5701', 'N5804', 'N6815', 'N6819', 'N6828'];
const secondaryDealers = ['N5216', 'N6844', 'N6845', 'N6846', 'N6847', 'N6848'];

const logsDir = config.logsDir || './logs';
const primaryStateFile = 'hmil-primary-op-wise-2021-2025-state.json';
const secondaryStateFile = 'hmil-secondary-op-wise-2021-2025-state.json';

// Handle --fresh flag to start a fresh run from scratch
const isFresh = process.argv.includes('--fresh');
if (isFresh) {
  console.log('Fresh run requested. Deleting existing state files if they exist...');
  await fsp.unlink(path.join(logsDir, primaryStateFile)).catch(() => {});
  await fsp.unlink(path.join(logsDir, secondaryStateFile)).catch(() => {});
}

const { runGdmsReportFirstHistoricalBackfill } = await import('./hmil-report-first-historical-runner.js');

console.log('========================================================================');
console.log('  Hyundai (HMIL) 2021-2025 Operation-Wise Analysis Report Backfill');
console.log('========================================================================');
console.log(`Start Date:    ${process.env.HMIL_HISTORICAL_START_DATE}`);
console.log(`End Date:      ${process.env.HMIL_HISTORICAL_END_DATE}`);
console.log(`Report:        hyundai-operation-wise-analysis-report`);
console.log(`Headless:      ${process.env.HMIL_HISTORICAL_HEADLESS}`);
console.log(`OTP Provider:  ${process.env.HMIL_HISTORICAL_OTP_PROVIDER}`);
console.log(`Skip Existing: ${process.env.HMIL_HISTORICAL_SKIP_EXISTING}`);
console.log(`Mode:          ${isFresh ? 'Fresh Run' : 'Resume Run'}`);
console.log('========================================================================\n');

let phase1Success = false;
let phase2Success = false;

// Phase 1: Primary Account (sahiltech)
console.log(`\n▶ PHASE 1: Running for HMIL Primary (sahiltech) for dealers: ${primaryDealers.join(', ')}`);
process.env.HMIL_HISTORICAL_DEALERS = primaryDealers.join(',');

try {
  await runGdmsReportFirstHistoricalBackfill({
    accountId: 'hmil',
    envPrefix: 'HMIL',
    stateFileName: primaryStateFile,
    logFilePrefix: 'hmil-primary-op-wise-2021-2025',
    serviceName: 'hmil-primary-op-wise-2021-2025'
  });
  console.log('✅ Phase 1 completed.');
  phase1Success = true;
} catch (error) {
  console.error('❌ Phase 1 failed:', error.message);
}

// Phase 2: Secondary Account (MIS5216)
console.log(`\n▶ PHASE 2: Running for HMIL Secondary (MIS5216) for dealers: ${secondaryDealers.join(', ')}`);
process.env.HMIL_HISTORICAL_DEALERS = secondaryDealers.join(',');

try {
  await runGdmsReportFirstHistoricalBackfill({
    accountId: 'hmil-secondary',
    envPrefix: 'HMIL',
    stateFileName: secondaryStateFile,
    logFilePrefix: 'hmil-secondary-op-wise-2021-2025',
    serviceName: 'hmil-secondary-op-wise-2021-2025'
  });
  console.log('✅ Phase 2 completed.');
  phase2Success = true;
} catch (error) {
  console.error('❌ Phase 2 failed:', error.message);
}

// Perform Migration and Merging at the end
console.log('\n========================================================================');
console.log('   Running Post-Backfill Code Migration & Deduplication');
console.log('========================================================================');

try {
  const { withPostgresClient } = await import('../src/supabase/postgres.js');
  
  await withPostgresClient(async client => {
    const MAPPINGS = {
      'N5203': 'N5216',
      'N5701': 'N6844',
      'N5804': 'N6845',
      'N6815': 'N6846',
      'N6819': 'N6847',
      'N6828': 'N6848'
    };

    console.log('Mapping old dealer codes to new dealer codes in the database...');
    for (const [oldCode, newCode] of Object.entries(MAPPINGS)) {
      // Update dealer_code
      const resDlr = await client.query(`
        UPDATE public.hyundai_operation_wise_analysis_report
        SET dealer_code = $1
        WHERE dealer_code = $2
      `, [newCode, oldCode]);
      if (resDlr.rowCount > 0) {
        console.log(`  Updated dealer_code column: ${oldCode} -> ${newCode} (${resDlr.rowCount} rows)`);
      }

      // Update source_dealer_code
      const resSrc = await client.query(`
        UPDATE public.hyundai_operation_wise_analysis_report
        SET source_dealer_code = $1
        WHERE source_dealer_code = $2
      `, [newCode, oldCode]);
      if (resSrc.rowCount > 0) {
        console.log(`  Updated source_dealer_code column: ${oldCode} -> ${newCode} (${resSrc.rowCount} rows)`);
      }
    }

    console.log('\nRunning database deduplication on table public.hyundai_operation_wise_analysis_report...');
    const { dedupeRelationalTables } = await import('../src/supabase/dedupe-relational-tables.js');
    await dedupeRelationalTables({
      tables: ['hyundai_operation_wise_analysis_report'],
      dryRun: false
    });
    console.log('Deduplication completed successfully.');
  });
  console.log('✅ Post-backfill migration and merging complete.');
} catch (error) {
  console.error('❌ Post-backfill migration failed:', error.message);
}

console.log('\nAll backfill phases and post-run database operations completed.');

import { runGdmsReportFirstHistoricalBackfill } from './hmil-report-first-historical-runner.js';
import { toIsoDate } from '../src/utils/date-range.js';

// Setup default envs if not already specified in process.env
process.env.HMIL_HISTORICAL_START_DATE = process.env.HMIL_HISTORICAL_START_DATE || '2021-01-01';
process.env.HMIL_HISTORICAL_END_DATE = process.env.HMIL_HISTORICAL_END_DATE || toIsoDate(new Date());
process.env.HMIL_HISTORICAL_REPORTS = process.env.HMIL_HISTORICAL_REPORTS || 'hyundai-repair-order-list,hyundai-ro-billing-report,hyundai-operation-wise-analysis-report';
process.env.HMIL_HISTORICAL_HEADLESS = process.env.HMIL_HISTORICAL_HEADLESS || 'false';
process.env.HMIL_HISTORICAL_OTP_PROVIDER = 'manual'; // Lock to manual OTP so user can type it in terminal when prompted
process.env.HMIL_HISTORICAL_RESUME_FROM_STATE = process.env.HMIL_HISTORICAL_RESUME_FROM_STATE || 'true';
process.env.HMIL_HISTORICAL_STOP_ON_FAILURE = process.env.HMIL_HISTORICAL_STOP_ON_FAILURE || 'false';

const primaryDealerList = ['N5203', 'N5701', 'N5804', 'N5806', 'N5D00', 'N6815', 'N6819', 'N6826'];
const secondaryDealerList = ['N5216', 'N6844', 'N6845', 'N6846', 'N6847', 'N6848'];

// Get user-specified dealers, or default to all of them
const userDealersStr = process.env.HMIL_HISTORICAL_DEALERS;
let targetPrimaryDealers = [];
let targetSecondaryDealers = [];

if (userDealersStr) {
  const parsed = userDealersStr.split(',').map(d => d.trim().toUpperCase()).filter(Boolean);
  targetPrimaryDealers = parsed.filter(d => primaryDealerList.includes(d));
  targetSecondaryDealers = parsed.filter(d => secondaryDealerList.includes(d));
  
  // If user specified a dealer code not present in either predefined list, default to primary
  const otherDealers = parsed.filter(d => !primaryDealerList.includes(d) && !secondaryDealerList.includes(d));
  if (otherDealers.length > 0) {
    targetPrimaryDealers.push(...otherDealers);
  }
} else {
  targetPrimaryDealers = primaryDealerList;
  targetSecondaryDealers = secondaryDealerList;
}

console.log('========================================================');
console.log('   Hyundai (HMIL) Custom Historical Recovery Backfill');
console.log('========================================================');
console.log(`Reports:      ${process.env.HMIL_HISTORICAL_REPORTS}`);
console.log(`Start Date:   ${process.env.HMIL_HISTORICAL_START_DATE}`);
console.log(`End Date:     ${process.env.HMIL_HISTORICAL_END_DATE}`);
console.log(`Headless:     ${process.env.HMIL_HISTORICAL_HEADLESS}`);
console.log(`OTP Provider: ${process.env.HMIL_HISTORICAL_OTP_PROVIDER} (Always manual in terminal)`);
console.log(`Resume State: ${process.env.HMIL_HISTORICAL_RESUME_FROM_STATE}`);
console.log('========================================================\n');

if (targetPrimaryDealers.length > 0) {
  console.log(`\n▶ PHASE 1: Running for HMIL Primary (sahiltech) for dealers: ${targetPrimaryDealers.join(', ')}`);
  process.env.HMIL_HISTORICAL_DEALERS = targetPrimaryDealers.join(',');
  try {
    await runGdmsReportFirstHistoricalBackfill({
      accountId: 'hmil',
      envPrefix: 'HMIL',
      stateFileName: 'hmil-primary-custom-historical-backfill-state.json',
      logFilePrefix: 'hmil-primary-custom-historical-backfill',
      serviceName: 'hmil-primary-custom-historical-backfill'
    });
    console.log('✅ Phase 1 complete.');
  } catch (error) {
    console.error('❌ Phase 1 failed:', error.message);
  }
}

if (targetSecondaryDealers.length > 0) {
  console.log(`\n▶ PHASE 2: Running for HMIL Secondary (MIS5216) for dealers: ${targetSecondaryDealers.join(', ')}`);
  process.env.HMIL_HISTORICAL_DEALERS = targetSecondaryDealers.join(',');
  try {
    await runGdmsReportFirstHistoricalBackfill({
      accountId: 'hmil-secondary',
      envPrefix: 'HMIL',
      stateFileName: 'hmil-secondary-custom-historical-backfill-state.json',
      logFilePrefix: 'hmil-secondary-custom-historical-backfill',
      serviceName: 'hmil-secondary-custom-historical-backfill'
    });
    console.log('✅ Phase 2 complete.');
  } catch (error) {
    console.error('❌ Phase 2 failed:', error.message);
  }
}

console.log('\nAll requested phases completed.');

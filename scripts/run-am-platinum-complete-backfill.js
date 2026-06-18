import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAmPlatinumSessionCachePaths } from '../src/accounts/am-platinum-accounts.js';
import {
  AM_PLATINUM_FULL_HISTORICAL_START,
  AM_PLATINUM_RECENT_HISTORICAL_START
} from '../src/am-platinum/historical-date-policy.js';
import { config } from '../src/config.js';
import { toIsoDate } from '../src/utils/date-range.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const today = toIsoDate(new Date());
const dealers = (config.amPlatinumDealerCodes?.length
  ? config.amPlatinumDealerCodes
  : ['N5211', 'N6250', 'N6828']).join(',');

const PIPELINE_LOG = path.join(config.logsDir, `am-platinum-complete-backfill-${today}.log`);

async function appendLog(line) {
  await fs.mkdir(config.logsDir, { recursive: true });
  await fs.appendFile(PIPELINE_LOG, `${line}\n`);
  console.log(line);
}

async function clearSessionCache() {
  for (const filePath of listAmPlatinumSessionCachePaths()) {
    await fs.unlink(filePath).catch(() => {});
    await fs.unlink(`${filePath}.meta.json`).catch(() => {});
  }
}

function runNodeScript(scriptRelativePath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(projectRoot, scriptRelativePath);
    const child = spawn(process.execPath, [scriptPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HEADLESS: 'false',
        OTP_PROVIDER: 'manual',
        AM_PLATINUM_HISTORICAL_OTP_PROVIDER: 'manual',
        GDMS_OTP_LOCK_ENABLED: 'false',
        AM_PLATINUM_FORCE_LOGIN: 'true',
        AM_PLATINUM_HISTORICAL_FORCE_LOGIN: 'true',
        AM_PLATINUM_HISTORICAL_HEADLESS: 'false',
        AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE: 'false',
        AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE: 'true',
        AM_PLATINUM_HISTORICAL_DEALERS: dealers,
        AM_PLATINUM_HISTORICAL_END_DATE: today,
        LOG_SERVICE_NAME: 'am-platinum-complete-backfill',
        ...extraEnv
      },
      stdio: 'inherit',
      shell: false
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scriptRelativePath} exited with code ${code}`));
      }
    });
  });
}

const sharedHistoricalEnv = {
  AM_PLATINUM_HISTORICAL_SKIP_EXISTING: 'false'
};

const STEPS = [
  {
    title: 'Operation Wise (2021 → today)',
    script: 'scripts/recover-am-platinum-operation-wise.js',
    env: {
      AM_PLATINUM_OPERATION_WISE_START_DATE: AM_PLATINUM_FULL_HISTORICAL_START,
      AM_PLATINUM_OPERATION_WISE_END_DATE: today,
      AM_PLATINUM_OPERATION_WISE_DEALERS: dealers,
      AM_PLATINUM_OPERATION_WISE_SKIP_EXISTING: 'true',
      AM_PLATINUM_OPERATION_WISE_RESET_STATE: 'false'
    }
  },
  {
    title: 'Repair Order List (2021 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-repair-order-list',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_FULL_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-repair-order-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-repair-order'
    }
  },
  {
    title: 'RO Billing (2021 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-ro-billing-report',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_FULL_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-ro-billing-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-ro-billing'
    }
  },
  {
    title: 'Call Center Complaints (2024 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-call-center-complaints',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_RECENT_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-call-center-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-call-center'
    }
  },
  {
    title: 'Customer Complaint List (2024 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-customer-complaint-list',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_RECENT_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-customer-complaints-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-customer-complaints'
    }
  },
  {
    title: 'Demo Car List (2024 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-demo-car-list',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_RECENT_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-demo-car-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-demo-car'
    }
  },
  {
    title: 'Service Appointment (2024 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-service-appointment',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_RECENT_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-service-appt-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-service-appt'
    }
  },
  {
    title: 'Trust Package (2024 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-trust-package-bodyshop-sot,hyundai-trust-package-sot-super,hyundai-trust-package-package-list',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_RECENT_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-trust-package-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-trust-package'
    }
  },
  {
    title: 'PSF Yearly (2024 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-psf-yearly',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_RECENT_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-psf-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-psf'
    }
  },
  {
    title: 'EW Report (2024 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-ew-report',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_RECENT_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-ew-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-ew'
    }
  },
  {
    title: 'Adv Wise Lubricants VAS (2024 → today)',
    script: 'scripts/run-am-platinum-historical-backfill.js',
    env: {
      ...sharedHistoricalEnv,
      AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-adv-wise-lubricants-vas',
      AM_PLATINUM_HISTORICAL_START_DATE: AM_PLATINUM_RECENT_HISTORICAL_START,
      AM_PLATINUM_HISTORICAL_STATE_FILE: 'am-platinum-complete-adv-vas-state.json',
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: 'am-platinum-complete-adv-vas'
    }
  }
];

async function main() {
  await fs.mkdir(config.logsDir, { recursive: true });
  await fs.writeFile(PIPELINE_LOG, `AM Platinum complete backfill started ${new Date().toISOString()}\n`);

  await appendLog('');
  await appendLog('═'.repeat(72));
  await appendLog('  AM Platinum Complete Backfill');
  await appendLog('═'.repeat(72));
  await appendLog(`  Dealers: ${dealers}`);
  await appendLog(`  Full historical (2021→today): Repair Order, RO Billing, Operation Wise`);
  await appendLog(`  Recent only (2024→today): all other reports`);
  await appendLog(`  End date: ${today}`);
  await appendLog(`  Master log: ${PIPELINE_LOG}`);
  await appendLog('  Type OTP when prompted (MIS1988 / MIS12345 as needed per month).');
  await appendLog('═'.repeat(72));
  await appendLog('');

  await clearSessionCache();
  await appendLog('Cleared AM Platinum session cache.');

  const failures = [];

  for (const [index, step] of STEPS.entries()) {
    await appendLog(`▶ Step ${index + 1}/${STEPS.length}: ${step.title}`);
    try {
      await runNodeScript(step.script, step.env);
      await appendLog(`✅ Step ${index + 1} completed: ${step.title}`);
    } catch (error) {
      failures.push({ step: step.title, error: error.message });
      await appendLog(`❌ Step ${index + 1} failed: ${step.title} — ${error.message}`);
      await appendLog('   Continuing with next step...');
    }
    await appendLog('');
  }

  await appendLog('Running final coverage check...');
  try {
    await runNodeScript('scripts/analyze-am-platinum-per-dealer-coverage.js', {});
  } catch (error) {
    await appendLog(`Coverage check exited with error: ${error.message}`);
  }

  await appendLog('');
  await appendLog('═'.repeat(72));
  if (failures.length === 0) {
    await appendLog('  ALL STEPS COMPLETED');
  } else {
    await appendLog(`  FINISHED WITH ${failures.length} FAILED STEP(S)`);
    for (const failure of failures) {
      await appendLog(`    - ${failure.step}: ${failure.error}`);
    }
    process.exitCode = 1;
  }
  await appendLog('═'.repeat(72));
}

main().catch(async error => {
  console.error(error);
  await appendLog(`Fatal error: ${error.message}`).catch(() => {});
  process.exit(1);
});

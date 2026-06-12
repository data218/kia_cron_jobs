import { spawn } from 'node:child_process';
import { loginToKiaDms } from '../src/auth/login.js';
import { config } from '../src/config.js';
import { changeActiveDealer } from '../src/navigation/dealer-change.js';
import { logger } from '../src/utils/logger.js';

const modes = [
  'regular',
  'open-ro-yearly',
  'kia-call-center-complaints',
  'demo-job-cards',
  'demo-car-list'
];

const regularKiaReportIds = [
  'ro-billing',
  'psf-yearly',
  'ew-report',
  'mcp-report',
  'adv-wise-lubricants-vas',
  'operation-wise-analysis-report',
  'operation-wise-analysis-advisor-report'
];

const skipCurrentPass = process.env.SKIP_CURRENT_PASS === 'true';
const continueOnReportFailure = process.env.CONTINUE_ON_REPORT_FAILURE !== 'false';

const normalRunEnv = {
  MULTI_DEALER_ENABLED: 'false',
  FORCE_ACTIVE_DEALER_CODE: '',
  HISTORICAL_BACKFILL_ENABLED: 'false',
  RO_BILLING_BACKFILL_ENABLED: 'false',
  DEMO_JOB_CARDS_BACKFILL_ENABLED: 'false',
  DEMO_CAR_LIST_BACKFILL_ENABLED: 'false',
  OPERATION_WISE_ANALYSIS_BACKFILL_ENABLED: 'false',
  OPERATION_WISE_ANALYSIS_ADVISOR_BACKFILL_ENABLED: 'false',
  KIA_CALL_CENTER_COMPLAINTS_NO_SEARCH_BACKFILL: 'false',
  REPORT_DATE_OVERRIDE_START_DATE: '',
  REPORT_DATE_OVERRIDE_END_DATE: '',
  REPORTS_TO_RUN: 'all'
};

const jk501HistoricalEnv = {
  MULTI_DEALER_ENABLED: 'false',
  FORCE_ACTIVE_DEALER_CODE: 'JK501',
  HISTORICAL_BACKFILL_ENABLED: 'true',
  HISTORICAL_BACKFILL_START_DATE: '2025-01-01',
  RO_BILLING_BACKFILL_ENABLED: 'true',
  RO_BILLING_BACKFILL_START_DATE: '2025-01-01',
  OPEN_RO_YEARLY_START_DATE: '2025-01-01',
  DEMO_JOB_CARDS_BACKFILL_ENABLED: 'true',
  DEMO_JOB_CARDS_BACKFILL_START_DATE: '2025-01-01',
  DEMO_CAR_LIST_BACKFILL_ENABLED: 'true',
  DEMO_CAR_LIST_BACKFILL_START_DATE: '2025-01-01',
  OPERATION_WISE_ANALYSIS_BACKFILL_ENABLED: 'true',
  OPERATION_WISE_ANALYSIS_BACKFILL_START_DATE: '2025-01-01',
  OPERATION_WISE_ANALYSIS_ADVISOR_BACKFILL_ENABLED: 'true',
  OPERATION_WISE_ANALYSIS_ADVISOR_BACKFILL_START_DATE: '2025-01-01',
  KIA_CALL_CENTER_COMPLAINTS_NO_SEARCH_BACKFILL: 'false',
  REPORT_DATE_OVERRIDE_START_DATE: '',
  REPORT_DATE_OVERRIDE_END_DATE: ''
};

function childEnv(extraEnv = {}) {
  return {
    ...process.env,
    ...extraEnv
  };
}

function runSchedulerMode(mode, extraEnv = {}, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    logger.info('Starting one-off scheduler child process', {
      mode,
      reportsToRun: extraEnv.REPORTS_TO_RUN ?? process.env.REPORTS_TO_RUN ?? 'all',
      historicalBackfillEnabled: extraEnv.HISTORICAL_BACKFILL_ENABLED
    });

    const child = spawn(process.execPath, ['src/cron/scheduler.js', '--once', `--mode=${mode}`], {
      cwd: config.rootDir,
      env: childEnv(extraEnv),
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        logger.info('One-off scheduler child process completed', { mode });
        resolve({ ok: true, mode });
      } else {
        const error = new Error(`Scheduler mode ${mode} exited with code ${code}`);
        if (allowFailure) {
          logger.error('One-off scheduler child process failed; continuing', {
            mode,
            code,
            err: {
              name: error.name,
              message: error.message,
              stack: error.stack
            }
          });
          resolve({ ok: false, mode, error });
          return;
        }
        reject(error);
      }
    });
  });
}

async function switchDealer(dealerCode) {
  logger.info('Opening KIA DMS session for dealer switch', { dealerCode });
  const session = await loginToKiaDms();
  try {
    await changeActiveDealer(session.page, dealerCode);
  } finally {
    await session.close?.().catch(() => {});
    await session.browser?.close?.().catch(() => {});
  }
}

async function runNormalCurrentDealerPass() {
  if (skipCurrentPass) {
    logger.warn('Skipping normal current-dealer one-off pass by request');
    return [];
  }

  logger.info('Starting normal current-dealer one-off pass');
  const results = [];
  for (const mode of modes) {
    results.push(await runSchedulerMode(mode, normalRunEnv, {
      allowFailure: continueOnReportFailure
    }));
  }
  return results;
}

async function runHistoricalRegularReportsIndividually() {
  const results = [];
  for (const reportId of regularKiaReportIds) {
    results.push(await runSchedulerMode('regular', {
      ...jk501HistoricalEnv,
      REPORTS_TO_RUN: reportId
    }, {
      allowFailure: continueOnReportFailure
    }));
  }
  return results;
}

async function runJk501HistoricalPass() {
  logger.info('Starting JK501 historical one-off pass');
  const results = await runHistoricalRegularReportsIndividually();
  for (const mode of modes) {
    if (mode === 'regular') continue;
    const env = {
      ...jk501HistoricalEnv,
      REPORTS_TO_RUN: 'all'
    };
    results.push(await runSchedulerMode(mode, env, {
      allowFailure: continueOnReportFailure
    }));
  }
  return results;
}

async function main() {
  const primaryDealerCode = config.primaryDealerCode || 'JK402';
  const targetDealerCode = 'JK501';

  logger.info('JK501 historical one-off orchestration started', {
    primaryDealerCode,
    targetDealerCode,
    modes
  });

  const results = [
    ...await runNormalCurrentDealerPass()
  ];

  await switchDealer(targetDealerCode);
  try {
    results.push(...await runJk501HistoricalPass());
  } finally {
    await switchDealer(primaryDealerCode);
  }

  const failures = results.filter(result => result && !result.ok);
  if (failures.length) {
    throw new Error(`JK501 historical one-off completed with ${failures.length} failed child run(s)`);
  }

  logger.info('JK501 historical one-off orchestration completed', {
    primaryDealerCode,
    targetDealerCode
  });
}

main().catch(error => {
  logger.error('JK501 historical one-off orchestration failed', {
    err: {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  });
  process.exitCode = 1;
});

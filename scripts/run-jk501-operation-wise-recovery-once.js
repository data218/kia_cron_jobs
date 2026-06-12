import { spawn } from 'node:child_process';
import { loginToKiaDms } from '../src/auth/login.js';
import { config } from '../src/config.js';
import { changeActiveDealer } from '../src/navigation/dealer-change.js';
import { logger } from '../src/utils/logger.js';

function childEnv(extraEnv = {}) {
  return {
    ...process.env,
    ...extraEnv
  };
}

const historicalEnv = {
  MULTI_DEALER_ENABLED: 'false',
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

function runSchedulerChild({ mode, extraEnv, label, allowFailure = true }) {
  return new Promise((resolve, reject) => {
    logger.info('Starting JK501 recovery child process', { mode, label });

    const child = spawn(process.execPath, ['src/cron/scheduler.js', '--once', `--mode=${mode}`], {
      cwd: config.rootDir,
      env: childEnv(extraEnv),
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        logger.info('JK501 recovery child process completed', { mode, label });
        resolve({ ok: true, mode, label });
        return;
      }

      const error = new Error(`JK501 recovery ${label} exited with code ${code}`);
      if (allowFailure) {
        logger.error('JK501 recovery child process failed; continuing', {
          mode,
          label,
          code,
          err: {
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        });
        resolve({ ok: false, mode, label, error });
        return;
      }

      reject(error);
    });
  });
}

function runOperationWiseRecovery({ reportTypes, startDate }) {
  return runSchedulerChild({
    mode: 'regular',
    label: `operation-wise-${reportTypes}-${startDate}`,
    extraEnv: {
      MULTI_DEALER_ENABLED: 'false',
      FORCE_ACTIVE_DEALER_CODE: 'JK501',
      REPORTS_TO_RUN: 'operation-wise-analysis-report',
      HISTORICAL_BACKFILL_ENABLED: 'false',
      OPERATION_WISE_ANALYSIS_BACKFILL_ENABLED: 'true',
      OPERATION_WISE_ANALYSIS_BACKFILL_START_DATE: startDate,
      OPERATION_WISE_ANALYSIS_REPORT_TYPES: reportTypes,
      REPORT_DATE_OVERRIDE_START_DATE: '',
      REPORT_DATE_OVERRIDE_END_DATE: ''
    }
  });
}

function runAdvisorRecovery() {
  return runSchedulerChild({
    mode: 'regular',
    label: 'operation-wise-analysis-advisor-resume',
    extraEnv: {
      MULTI_DEALER_ENABLED: 'false',
      FORCE_ACTIVE_DEALER_CODE: 'JK501',
      REPORTS_TO_RUN: 'operation-wise-analysis-advisor-report',
      HISTORICAL_BACKFILL_ENABLED: 'false',
      OPERATION_WISE_ANALYSIS_ADVISOR_BACKFILL_ENABLED: 'true',
      OPERATION_WISE_ANALYSIS_ADVISOR_BACKFILL_START_DATE: '2025-01-01',
      OPERATION_WISE_ANALYSIS_ADVISOR_START_AT_ADVISOR: 'SUNIL KUMAR',
      OPERATION_WISE_ANALYSIS_ADVISOR_START_AT_DATE: '2025-12-01',
      REPORT_DATE_OVERRIDE_START_DATE: '',
      REPORT_DATE_OVERRIDE_END_DATE: ''
    }
  });
}

function runHistoricalMode(mode) {
  return runSchedulerChild({
    mode,
    label: mode,
    extraEnv: {
      ...historicalEnv,
      FORCE_ACTIVE_DEALER_CODE: 'JK501',
      REPORTS_TO_RUN: 'all'
    }
  });
}

async function switchDealer(dealerCode) {
  logger.info('Opening KIA DMS session for Operation Wise recovery dealer switch', { dealerCode });
  const session = await loginToKiaDms();
  try {
    await changeActiveDealer(session.page, dealerCode);
  } finally {
    await session.close?.().catch(() => {});
    await session.browser?.close?.().catch(() => {});
  }
}

async function main() {
  const primaryDealerCode = config.primaryDealerCode || 'JK402';
  const targetDealerCode = 'JK501';

  logger.info('JK501 Operation Wise recovery orchestration started', {
    primaryDealerCode,
    targetDealerCode
  });

  await switchDealer(targetDealerCode);
  const results = [];
  try {
    results.push(await runOperationWiseRecovery({
      reportTypes: 'Operation',
      startDate: '2026-05-01'
    }));
    results.push(await runOperationWiseRecovery({
      reportTypes: 'Part',
      startDate: '2025-01-01'
    }));
    results.push(await runAdvisorRecovery());
    for (const mode of [
      'open-ro-yearly',
      'kia-call-center-complaints',
      'demo-job-cards',
      'demo-car-list'
    ]) {
      results.push(await runHistoricalMode(mode));
    }
  } finally {
    await switchDealer(primaryDealerCode);
  }

  const failures = results.filter(result => result && !result.ok);
  if (failures.length) {
    throw new Error(`JK501 recovery completed with ${failures.length} failed child run(s)`);
  }

  logger.info('JK501 Operation Wise recovery orchestration completed', {
    primaryDealerCode,
    targetDealerCode
  });
}

main().catch(error => {
  logger.error('JK501 Operation Wise recovery orchestration failed', {
    err: {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  });
  process.exitCode = 1;
});

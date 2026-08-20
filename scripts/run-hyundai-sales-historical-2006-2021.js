// Multi-dealer runner script for Hyundai Sales Report (Historical 2006-2021)
process.env.HEADLESS = 'false';

import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { downloadHyundaiSalesReport } from '../src/reports/hyundai-sales-report.js';
import { logger } from '../src/utils/logger.js';

async function ensureSession(sessionRef, account) {
  if (!sessionRef.current || !sessionRef.current.page || sessionRef.current.page.isClosed()) {
    logger.warn('Browser session page is closed or missing; re-authenticating HMIL DMS session...');
    sessionRef.current = await loginToHmilDms(account);
  }
  return sessionRef.current;
}

async function main() {
  const account = createGdmsAccountProfile('hmil-secondary');
  account.headless = false;

  const dealerCodes = ['N5216', 'N6844', 'N6845', 'N6846', 'N6847', 'N6848'];
  const startDate = '2006-01-01';
  const endDate = '2021-01-01';

  logger.info('Starting Historical Hyundai Sales Report Run (2006-2021)...', {
    userId: account.userId,
    dealerCodes,
    startDate,
    endDate,
    headless: false
  });

  const sessionRef = { current: await loginToHmilDms(account) };
  let activeDealerCode = null;

  try {
    for (const dealerCode of dealerCodes) {
      logger.info('========== STARTING HISTORICAL SALES BACKFILL FOR DEALER ==========', {
        dealerCode,
        startDate,
        endDate
      });

      let session = await ensureSession(sessionRef, account);

      try {
        if (activeDealerCode !== dealerCode) {
          logger.info('Switching active HMIL dealer code...', { from: activeDealerCode, to: dealerCode });
          await changeActiveDealerForDms(session.page, dealerCode, {
            homeUrl: account.homeUrl,
            systemLabel: account.systemLabel
          });
          activeDealerCode = dealerCode;
          logger.info('Active HMIL dealer code successfully set', { activeDealerCode });
        }
      } catch (switchError) {
        logger.error('Failed to switch HMIL dealer code; skipping this dealer', {
          dealerCode,
          error: switchError.message
        });
        continue;
      }

      session = await ensureSession(sessionRef, account);
      logger.info('Running Hyundai Sales Report (2006-2021)', { dealerCode, startDate, endDate });

      try {
        const result = await downloadHyundaiSalesReport(session.page, {
          dealerCode,
          account,
          startDate,
          endDate
        });
        logger.info('Hyundai Sales Report historical backfill finished for dealer', {
          dealerCode,
          startDate,
          endDate,
          result
        });
      } catch (reportError) {
        logger.error('Hyundai Sales Report historical backfill failed for dealer', {
          dealerCode,
          startDate,
          endDate,
          error: reportError.message,
          stack: reportError.stack
        });
      }
    }

    logger.info('All Hyundai Historical Sales Reports (2006-2021) completed successfully');
  } finally {
    if (sessionRef.current?.browser) {
      await sessionRef.current.browser.close().catch(() => {});
    }
  }
}

main().catch(error => {
  logger.error('Historical Hyundai Sales Report run failed', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});

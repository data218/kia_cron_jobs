// Multi-dealer runner script for Hyundai Enquiry Report across all remaining dealer codes
process.env.HEADLESS = 'false';

import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { downloadHyundaiEnquiryReport } from '../src/reports/hyundai-enquiry-report.js';
import { logger } from '../src/utils/logger.js';

const REPORTS = [
  { name: 'Hyundai Enquiry Report', run: downloadHyundaiEnquiryReport }
];

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

  logger.info('Starting Multi-Dealer Hyundai Enquiry Report Run...', {
    userId: account.userId,
    dealerCodes,
    reportCount: REPORTS.length,
    headless: false
  });

  const sessionRef = { current: await loginToHmilDms(account) };
  let activeDealerCode = null;

  try {
    for (const dealerCode of dealerCodes) {
      logger.info('========== STARTING DEALER CODE ==========', { dealerCode });

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

      for (const report of REPORTS) {
        session = await ensureSession(sessionRef, account);
        logger.info('Running report for dealer', { report: report.name, dealerCode });
        try {
          const result = await report.run(session.page, { dealerCode, account });
          logger.info('Report for dealer finished successfully', { report: report.name, dealerCode, result });
        } catch (reportError) {
          logger.error('Report for dealer failed; continuing with remaining reports', {
            report: report.name,
            dealerCode,
            error: reportError.message,
            stack: reportError.stack
          });
        }
      }
    }

    logger.info('All Hyundai Multi-Dealer Enquiry Reports completed successfully');
  } finally {
    if (sessionRef.current?.browser) {
      await sessionRef.current.browser.close().catch(() => {});
    }
  }
}

main().catch(error => {
  logger.error('Multi-dealer Hyundai Enquiry Report run failed', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});

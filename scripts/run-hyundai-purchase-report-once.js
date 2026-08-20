// Script to run Hyundai Purchase Report with visible browser (HEADLESS=false)
process.env.HEADLESS = 'false';

import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { downloadHyundaiPurchaseReport } from '../src/reports/hyundai-purchase-report.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const account = createGdmsAccountProfile('hmil-secondary');
  account.headless = false;
  logger.info('Starting Hyundai Purchase Report manual run...', {
    userId: account.userId,
    dealerCodes: account.dealerCodes,
    headless: false
  });

  const session = await loginToHmilDms(account);
  try {
    const result = await downloadHyundaiPurchaseReport(session.page, {
      dealerCode: account.dealerCodes[0] || 'active',
      account
    });
    logger.info('Hyundai Purchase Report completed successfully', result);
  } finally {
    if (session.browser) {
      await session.browser.close().catch(() => {});
    }
  }
}

main().catch(error => {
  logger.error('Hyundai Purchase Report run failed', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});

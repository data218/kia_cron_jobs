// Script to run Hyundai Sales Report with visible browser (HEADLESS=false)
process.env.HEADLESS = 'false';

import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { downloadHyundaiSalesReport } from '../src/reports/hyundai-sales-report.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const account = createGdmsAccountProfile('hmil-secondary');
  account.headless = false;
  logger.info('Starting Hyundai Sales Report manual run...', {
    userId: account.userId,
    dealerCodes: account.dealerCodes,
    headless: false
  });



  const session = await loginToHmilDms(account);
  try {
    const result = await downloadHyundaiSalesReport(session.page, {
      dealerCode: account.dealerCodes[0] || 'active',
      account
    });
    logger.info('Hyundai Sales Report completed successfully', result);
  } finally {
    if (session.browser) {
      await session.browser.close().catch(() => {});
    }
  }
}

main().catch(error => {
  logger.error('Hyundai Sales Report run failed', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});

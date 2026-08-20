// AM Platinum Sales Report -> am_platinum_sales_report
//
// Same portal flow as the Hyundai Sales Report (MIS > Sales Report, confirmDate radio,
// 30-day chunks, page size 1000/300) — only the login and destination table differ. The
// AM Platinum GDMS profile applies the "AM Platinum" sheet prefix, which routes the rows to
// am_platinum_sales_report instead of hyundai_sales_report.
//
// Window defaults to 2025-01-01 -> today. Every AM Platinum dealer runs, one at a time:
// switch active dealer -> export that dealer fully -> next.
//
// Resumable: each 30-day chunk uploads to Postgres and writes a `.saved.json` marker.
// Browser is VISIBLE by default; pass --headless for the PM2 cron.
//
// Flags:
//   --start=YYYY-MM-DD  window start (default 2025-01-01)
//   --end=YYYY-MM-DD    window end   (default today)
//   --dealers=N5211,... override the dealer list
//   --headless

import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { downloadHyundaiSalesReport } from '../src/reports/hyundai-sales-report.js';
import { toIsoDate } from '../src/utils/date-range.js';
import { logger } from '../src/utils/logger.js';

function flag(name, fallback = null) {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const START_DATE = flag('start', '2025-01-01');
const END_DATE = flag('end') || toIsoDate(new Date());
const RUN_HEADLESS = process.argv.includes('--headless');
const DEALER_OVERRIDE = flag('dealers')
  ? flag('dealers').split(',').map(code => code.trim().toUpperCase()).filter(Boolean)
  : null;

async function ensureSession(sessionRef, account) {
  if (!sessionRef.current || !sessionRef.current.page || sessionRef.current.page.isClosed()) {
    logger.warn('AM Platinum session page is closed or missing; re-authenticating...');
    sessionRef.current = await loginToHmilDms(account);
  }
  return sessionRef.current;
}

async function main() {
  const account = createGdmsAccountProfile('am-platinum');
  // Set explicitly: .env carries HEADLESS=true and dotenv runs during the imports above,
  // so anything derived from it would silently be headless.
  account.headless = RUN_HEADLESS;

  const dealerCodes = DEALER_OVERRIDE ?? account.dealerCodes;
  if (!dealerCodes.length) {
    throw new Error('AM Platinum account has no dealer codes; set AM_PLATINUM_DEALER_CODES in .env');
  }

  logger.info('Starting AM Platinum Sales Report run', {
    userId: account.userId,
    dealerCodes,
    startDate: START_DATE,
    endDate: END_DATE,
    sheetName: account.sheetName('Hyundai Sales Report'),
    headless: account.headless
  });

  const sessionRef = { current: await loginToHmilDms(account) };
  let activeDealerCode = null;
  const summary = [];

  try {
    for (const dealerCode of dealerCodes) {
      logger.info('========== DEALER ==========', { dealerCode, startDate: START_DATE, endDate: END_DATE });

      let session = await ensureSession(sessionRef, account);

      try {
        if (activeDealerCode !== dealerCode) {
          logger.info('Switching active AM Platinum dealer code...', { from: activeDealerCode, to: dealerCode });
          await changeActiveDealerForDms(session.page, dealerCode, {
            homeUrl: account.homeUrl,
            systemLabel: account.systemLabel
          });
          activeDealerCode = dealerCode;
          logger.info('Active dealer set', { activeDealerCode });
        }
      } catch (switchError) {
        logger.error('Dealer switch failed; skipping dealer', { dealerCode, error: switchError.message });
        summary.push({ dealerCode, status: 'dealer_switch_failed', error: switchError.message });
        activeDealerCode = null;
        continue;
      }

      session = await ensureSession(sessionRef, account);

      try {
        const result = await downloadHyundaiSalesReport(session.page, {
          dealerCode,
          account,
          startDate: START_DATE,
          endDate: END_DATE
        });
        logger.info('Dealer sales report finished', { dealerCode, result });
        summary.push({
          dealerCode,
          status: result.failedChunks?.length ? 'completed_with_failed_chunks' : 'completed',
          sheetName: result.sheetName,
          rowCount: result.rowCount,
          savedChunkCount: result.savedChunkCount,
          skippedChunkCount: result.skippedChunkCount,
          failedChunks: result.failedChunks
        });
      } catch (reportError) {
        logger.error('Dealer sales report failed', {
          dealerCode, error: reportError.message, stack: reportError.stack
        });
        summary.push({ dealerCode, status: 'failed', error: reportError.message });
      }
    }

    logger.info('AM Platinum Sales Report run complete', { startDate: START_DATE, endDate: END_DATE, summary });
  } finally {
    if (sessionRef.current?.browser) {
      await sessionRef.current.browser.close().catch(() => {});
    }
  }

  if (summary.some(entry => entry.status !== 'completed')) process.exitCode = 1;
}

main().catch(error => {
  logger.error('AM Platinum Sales Report run failed', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});

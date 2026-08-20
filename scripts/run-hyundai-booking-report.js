// Hyundai Booking Report — MIS > Booking Reports > Booking Report (VIEW-D-01069).
//
// Runs the last 12 months month-by-month for EVERY dealer of BOTH GDMS logins, one dealer
// at a time (switch active dealer -> export that dealer fully -> next):
//
//   hmil-booking (AMMIS)     -> hyundai_booking_report
//   am-platinum              -> am_platinum_booking_report
//
// The two accounts run sequentially, never concurrently: each is a separate portal login
// with its own session, and the active dealer is server-side session state.
//
// Resumable: each month writes a `.saved.json` marker once its rows are in Postgres.
// Browser is VISIBLE by default; pass --headless for the PM2 cron.
//
// Flags:
//   --accounts=hmil-booking,am-platinum     which logins to run
//   --dealers=N5216,N6844                   override the dealer list (applies to all accounts)
//   --start=YYYY-MM-DD --end=YYYY-MM-DD     override the 12-month window
//   --headless

import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { downloadHyundaiBookingReport } from '../src/reports/hyundai-booking-report.js';
import { logger } from '../src/utils/logger.js';

function flag(name, fallback = null) {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const ACCOUNT_IDS = flag('accounts', 'hmil-booking,am-platinum')
  .split(',').map(id => id.trim()).filter(Boolean);
const DEALER_OVERRIDE = flag('dealers')
  ? flag('dealers').split(',').map(code => code.trim().toUpperCase()).filter(Boolean)
  : null;
const START_DATE = flag('start');
const END_DATE = flag('end');
const RUN_HEADLESS = process.argv.includes('--headless');

async function runAccount(accountId, summary) {
  const account = createGdmsAccountProfile(accountId);
  // Set explicitly: .env carries HEADLESS=true and dotenv runs during the imports above,
  // so anything derived from it would silently be headless.
  account.headless = RUN_HEADLESS;

  const dealerCodes = DEALER_OVERRIDE ?? account.dealerCodes;
  if (!dealerCodes.length) {
    logger.warn('Account has no dealer codes configured; skipping', { accountId });
    summary.push({ accountId, status: 'no_dealers' });
    return;
  }

  logger.info('########## ACCOUNT ##########', {
    accountId,
    userId: account.userId,
    dealerCodes,
    sheetName: account.sheetName('Hyundai Booking Report')
  });

  let session = await loginToHmilDms(account);
  let activeDealerCode = null;

  try {
    for (const dealerCode of dealerCodes) {
      logger.info('========== DEALER ==========', { accountId, dealerCode });

      if (!session.page || session.page.isClosed()) {
        logger.warn('Session page closed; re-authenticating', { accountId });
        session = await loginToHmilDms(account);
        activeDealerCode = null;
      }

      try {
        if (activeDealerCode !== dealerCode) {
          await changeActiveDealerForDms(session.page, dealerCode, {
            homeUrl: account.homeUrl,
            systemLabel: account.systemLabel
          });
          activeDealerCode = dealerCode;
          logger.info('Active dealer set', { accountId, activeDealerCode });
        }
      } catch (switchError) {
        logger.error('Dealer switch failed; skipping dealer', {
          accountId, dealerCode, error: switchError.message
        });
        summary.push({ accountId, dealerCode, status: 'dealer_switch_failed', error: switchError.message });
        activeDealerCode = null;
        continue;
      }

      try {
        const result = await downloadHyundaiBookingReport(session.page, {
          dealerCode,
          account,
          startDate: START_DATE,
          endDate: END_DATE
        });
        summary.push({
          accountId,
          dealerCode,
          status: result.failedRanges?.length ? 'completed_with_failed_months' : 'completed',
          sheetName: result.sheetName,
          rowCount: result.rowCount,
          savedChunkCount: result.savedChunkCount,
          skippedChunkCount: result.skippedChunkCount,
          failedRanges: result.failedRanges
        });
        logger.info('Dealer booking report finished', { accountId, dealerCode, result });
      } catch (reportError) {
        logger.error('Dealer booking report failed', {
          accountId, dealerCode, error: reportError.message, stack: reportError.stack
        });
        summary.push({ accountId, dealerCode, status: 'failed', error: reportError.message });
      }
    }
  } finally {
    // Closed before the next account logs in — two GDMS sessions must not overlap.
    if (session.browser) await session.browser.close().catch(() => {});
  }
}

async function main() {
  const summary = [];
  logger.info('Starting Hyundai Booking Report run', {
    accounts: ACCOUNT_IDS,
    startDate: START_DATE ?? '(12 months back)',
    endDate: END_DATE ?? '(today)',
    headless: RUN_HEADLESS
  });

  for (const accountId of ACCOUNT_IDS) {
    try {
      await runAccount(accountId, summary);
    } catch (accountError) {
      logger.error('Account run failed', { accountId, error: accountError.message, stack: accountError.stack });
      summary.push({ accountId, status: 'account_failed', error: accountError.message });
    }
  }

  logger.info('Hyundai Booking Report run complete', { summary });
  if (summary.some(entry => entry.status !== 'completed')) process.exitCode = 1;
}

main().catch(error => {
  logger.error('Hyundai Booking Report run failed', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});

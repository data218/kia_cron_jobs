// Historical backfill of the Hyundai Sales Report across every dealer under the MIS5216
// (hmil-secondary) login, one dealer at a time: switch the active dealer, export that
// dealer's full range, then move on.
//
// Deliberately does NOT use the `sahiltech` primary HMIL login.
//
// Resumable: each 30-day chunk uploads to Postgres and writes a `.saved.json` marker, so
// re-running skips everything already saved.
//
// The browser is VISIBLE by default. Pass --headless for an unattended run.
//
// IMPORTANT: the Sales Report has no Main Dealer dropdown — it is scoped purely by the
// ACTIVE dealer, which is server-side session state on the HMIL login. Do NOT run this at
// the same time as another automation using the same login (the enquiry backfill, or the
// hmil-cron-job PM2 process): whichever process switches dealer last wins, and this script
// would silently export one dealer's rows while tagging them as another's.

import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { downloadHyundaiSalesReport } from '../src/reports/hyundai-sales-report.js';
import { toIsoDate } from '../src/utils/date-range.js';
import { logger } from '../src/utils/logger.js';

// CLI flags rather than env vars so the same command works in PowerShell and bash.
function flag(name) {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const START_DATE = flag('start') || '2006-01-01';
const END_DATE_OVERRIDE = flag('end') || null;
const RUN_HEADLESS = process.argv.includes('--headless');
const DEALER_CODES = (flag('dealers') || 'N5216,N6844,N6845,N6846,N6847,N6848')
  .split(',')
  .map(code => code.trim().toUpperCase())
  .filter(Boolean);

async function ensureSession(sessionRef, account) {
  if (!sessionRef.current || !sessionRef.current.page || sessionRef.current.page.isClosed()) {
    logger.warn('HMIL DMS session page is closed or missing; re-authenticating...');
    sessionRef.current = await loginToHmilDms(account);
  }
  return sessionRef.current;
}

async function main() {
  const account = createGdmsAccountProfile('hmil-secondary');
  // Set explicitly rather than reading HEADLESS: .env carries HEADLESS=true and dotenv runs
  // during the imports above, so anything derived from it would silently be headless.
  account.headless = RUN_HEADLESS;
  account.forceLogin = process.env.HMIL_FORCE_LOGIN_BACKFILL === 'true';

  if (String(account.userId).toLowerCase() === 'sahiltech') {
    throw new Error('Refusing to run: resolved account is the sahiltech primary login');
  }

  const endDate = END_DATE_OVERRIDE || toIsoDate(new Date());

  logger.info('Starting Hyundai Sales Report historical backfill', {
    userId: account.userId,
    dealerCodes: DEALER_CODES,
    startDate: START_DATE,
    endDate,
    headless: account.headless
  });

  const sessionRef = { current: await loginToHmilDms(account) };
  let activeDealerCode = null;
  const summary = [];

  try {
    for (const dealerCode of DEALER_CODES) {
      logger.info('========== DEALER ==========', { dealerCode, startDate: START_DATE, endDate });

      let session = await ensureSession(sessionRef, account);

      try {
        if (activeDealerCode !== dealerCode) {
          logger.info('Switching active HMIL dealer code...', { from: activeDealerCode, to: dealerCode });
          await changeActiveDealerForDms(session.page, dealerCode, {
            homeUrl: account.homeUrl,
            systemLabel: account.systemLabel
          });
          activeDealerCode = dealerCode;
          logger.info('Active HMIL dealer code set', { activeDealerCode });
        }
      } catch (switchError) {
        logger.error('Failed to switch HMIL dealer code; skipping dealer', {
          dealerCode,
          error: switchError.message
        });
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
          endDate
        });
        logger.info('Dealer backfill finished', { dealerCode, result });
        summary.push({
          dealerCode,
          status: result.failedChunks?.length ? 'completed_with_failed_chunks' : 'completed',
          rowCount: result.rowCount,
          savedChunkCount: result.savedChunkCount,
          skippedChunkCount: result.skippedChunkCount,
          failedChunks: result.failedChunks
        });
      } catch (reportError) {
        logger.error('Dealer backfill failed', {
          dealerCode,
          error: reportError.message,
          stack: reportError.stack
        });
        summary.push({ dealerCode, status: 'failed', error: reportError.message });
      }
    }

    logger.info('Hyundai Sales Report historical backfill complete', {
      startDate: START_DATE,
      endDate,
      summary
    });
  } finally {
    if (sessionRef.current?.browser) {
      await sessionRef.current.browser.close().catch(() => {});
    }
  }

  if (summary.some(entry => entry.status !== 'completed')) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  logger.error('Hyundai Sales Report historical backfill run failed', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});

// Full historical backfill of the Hyundai Enquiry Report: 2006-01-01 -> today,
// every dealer under the MIS5216 (hmil-secondary) login, one dealer at a time.
//
// Deliberately does NOT use the `sahiltech` primary HMIL login.
//
// Resumable: each 30-day chunk writes a `.saved.json` marker once its rows are in
// Postgres, so re-running skips everything already uploaded.
//
// The browser is VISIBLE by default so the run can be watched. Set
// ENQUIRY_BACKFILL_HEADLESS=true for an unattended run.

import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import {
  downloadHyundaiEnquiryReport,
  listHyundaiEnquiryMainDealers
} from '../src/reports/hyundai-enquiry-report.js';
import { toIsoDate } from '../src/utils/date-range.js';
import { logger } from '../src/utils/logger.js';

// Fallback only. The dealers actually run are whatever the portal's Main Dealer dropdown
// offers for this login — see listHyundaiEnquiryMainDealers.
const FALLBACK_DEALER_CODES = ['N5216'];

// CLI flags rather than env vars so the same command works in PowerShell and bash.
function flag(name) {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const START_DATE = flag('start') || process.env.ENQUIRY_BACKFILL_START_DATE || '2006-01-01';
const END_DATE_OVERRIDE = flag('end') || process.env.ENQUIRY_BACKFILL_END_DATE || null;
const RUN_HEADLESS = process.argv.includes('--headless') ||
  process.env.ENQUIRY_BACKFILL_HEADLESS === 'true';

// Every dealer under the MIS5216 login. Run in this order, one at a time: switch the active
// dealer, export that dealer fully, only then move to the next.
const ALL_DEALER_CODES = (flag('dealers') || 'N5216,N6844,N6845,N6846,N6847,N6848')
  .split(',')
  .map(code => code.trim().toUpperCase())
  .filter(Boolean);

// Guard against writing a mislabelled copy of the same rows once per dealer.
const ALLOW_UNSCOPED = process.argv.includes('--allow-unscoped');

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
  // during the import above, so anything derived from it would silently be headless.
  // account.headless takes precedence over config.headless in createHmilBrowserSession.
  account.headless = RUN_HEADLESS;
  // Reuse the saved storage state. HMIL_FORCE_LOGIN=true in .env would demand a fresh OTP
  // on every start, which defeats a resumable backfill that may be restarted many times.
  account.forceLogin = process.env.HMIL_FORCE_LOGIN_BACKFILL === 'true';

  if (String(account.userId).toLowerCase() === 'sahiltech') {
    throw new Error('Refusing to run: resolved account is the sahiltech primary login');
  }

  const endDate = END_DATE_OVERRIDE || toIsoDate(new Date());

  logger.info('Starting Hyundai Enquiry Report historical backfill', {
    userId: account.userId,
    startDate: START_DATE,
    endDate,
    headless: account.headless
  });

  const sessionRef = { current: await loginToHmilDms(account) };
  let activeDealerCode = null;
  const summary = [];

  // Logged for context: the Main Dealer dropdown normally lists only the parent (N5216),
  // while the sub-dealers are reached by switching the ACTIVE dealer below.
  const discovered = await listHyundaiEnquiryMainDealers(sessionRef.current.page).catch(error => {
    logger.warn('Could not read the Main Dealer dropdown', { error: error.message });
    return [];
  });

  const dealerCodes = ALL_DEALER_CODES.length ? ALL_DEALER_CODES : FALLBACK_DEALER_CODES;

  logger.info('Dealers to back-fill, one at a time', {
    dealerCodes,
    mainDealerOptionsOnPortal: discovered.map(dealer => dealer.code),
    enforceScope: !ALLOW_UNSCOPED
  });

  try {
    for (const dealerCode of dealerCodes) {
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
        const result = await downloadHyundaiEnquiryReport(session.page, {
          dealerCode,
          account,
          startDate: START_DATE,
          endDate,
          enforceScope: !ALLOW_UNSCOPED
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
        summary.push({ dealerCode, status: 'failed', error: reportError.message });

        if (reportError.code === 'EXPORT_NOT_SCOPED') {
          logger.error('STOPPING: this portal does not scope the export per dealer', {
            dealerCode,
            error: reportError.message
          });
          break;
        }

        logger.error('Dealer backfill failed', {
          dealerCode,
          error: reportError.message,
          stack: reportError.stack
        });
      }
    }

    logger.info('Hyundai Enquiry Report historical backfill complete', {
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
  logger.error('Hyundai Enquiry Report historical backfill run failed', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});

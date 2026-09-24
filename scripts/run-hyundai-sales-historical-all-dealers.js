import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { downloadHyundaiSalesReport } from '../src/reports/hyundai-sales-report.js';
import { toIsoDate } from '../src/utils/date-range.js';
import { logger } from '../src/utils/logger.js';

function flag(name) {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function getCurrentMonthStartDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

const daysFlag = flag('days');
let START_DATE = flag('start');

if (!START_DATE && daysFlag) {
  const d = new Date(Date.now() - parseInt(daysFlag, 10) * 86400000);
  START_DATE = toIsoDate(d);
}

if (!START_DATE) {
  START_DATE = getCurrentMonthStartDate();
}

const END_DATE_OVERRIDE = flag('end') || null;
const RUN_HEADLESS = process.argv.includes('--headless');
const NO_DEALER_SWITCH = process.argv.includes('--no-switch-dealers');
const DEALER_CODES = NO_DEALER_SWITCH
  ? [flag('dealers') ? flag('dealers').split(',')[0].trim().toUpperCase() : 'N5216']
  : (flag('dealers') || 'N5216,N6844,N6845,N6846,N6847,N6848')
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
  account.headless = RUN_HEADLESS;
  account.forceLogin = process.env.HMIL_FORCE_LOGIN_BACKFILL === 'true';

  if (String(account.userId).toLowerCase() === 'sahiltech') {
    throw new Error('Refusing to run: resolved account is the sahiltech primary login');
  }

  const endDate = END_DATE_OVERRIDE || toIsoDate(new Date());

  logger.info('Starting Hyundai Sales Report run for current month', {
    userId: account.userId,
    dealerCodes: DEALER_CODES,
    noDealerSwitch: NO_DEALER_SWITCH,
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

      if (!NO_DEALER_SWITCH) {
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
      }

      session = await ensureSession(sessionRef, account);

      try {
        const result = await downloadHyundaiSalesReport(session.page, {
          dealerCode,
          account,
          startDate: START_DATE,
          endDate
        });
        logger.info('Dealer sales report finished', { dealerCode, result });
        summary.push({
          dealerCode,
          status: result.failedChunks?.length ? 'completed_with_failed_chunks' : 'completed',
          rowCount: result.rowCount,
          savedChunkCount: result.savedChunkCount,
          skippedChunkCount: result.skippedChunkCount,
          failedChunks: result.failedChunks
        });
      } catch (reportError) {
        logger.error('Dealer sales report failed', {
          dealerCode,
          error: reportError.message,
          stack: reportError.stack
        });
        summary.push({ dealerCode, status: 'failed', error: reportError.message });
      }
    }

    logger.info('Hyundai Sales Report run complete', {
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
  logger.error('Hyundai Sales Report run failed', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});

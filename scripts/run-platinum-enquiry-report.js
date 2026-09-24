import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { downloadHyundaiEnquiryReport } from '../src/reports/hyundai-enquiry-report.js';
import { toIsoDate } from '../src/utils/date-range.js';
import { logger } from '../src/utils/logger.js';

function flag(name, fallback = null) {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
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
  const NO_DEALER_SWITCH = process.argv.includes('--no-switch-dealers');
  const accountGroups = NO_DEALER_SWITCH
    ? [{ accountKey: 'am-platinum', dealerCodes: ['N6250'] }]
    : [
        { accountKey: 'am-platinum', dealerCodes: ['N6250'] },
        { accountKey: 'am-platinum-historical', dealerCodes: ['N5211', 'N6828'] }
      ];

  if (DEALER_OVERRIDE) {
    accountGroups[0].dealerCodes = DEALER_OVERRIDE.filter(d => d === 'N6250');
    if (!NO_DEALER_SWITCH && accountGroups[1]) {
      accountGroups[1].dealerCodes = DEALER_OVERRIDE.filter(d => d !== 'N6250');
    }
  }

  const summary = [];

  for (const group of accountGroups) {
    if (!group.dealerCodes.length) continue;

    const account = createGdmsAccountProfile(group.accountKey);
    account.headless = RUN_HEADLESS;

    logger.info('Starting AM Platinum Enquiry Report run group', {
      accountKey: group.accountKey,
      userId: account.userId,
      dealerCodes: group.dealerCodes,
      noDealerSwitch: NO_DEALER_SWITCH,
      startDate: START_DATE,
      endDate: END_DATE,
      headless: account.headless
    });

    let session = null;
    let activeDealerCode = null;

    try {
      session = await loginToHmilDms(account);
      const sessionRef = { current: session };

      for (const dealerCode of group.dealerCodes) {
        logger.info('========== DEALER ==========', { dealerCode, startDate: START_DATE, endDate: END_DATE });

        let currentSession = await ensureSession(sessionRef, account);

        if (!NO_DEALER_SWITCH) {
          try {
            if (activeDealerCode !== dealerCode) {
              logger.info('Switching active AM Platinum dealer...', { from: activeDealerCode, to: dealerCode });
              await changeActiveDealerForDms(currentSession.page, dealerCode, {
                homeUrl: account.homeUrl,
                systemLabel: account.systemLabel
              });
              activeDealerCode = dealerCode;
              logger.info('Active AM Platinum dealer set', { activeDealerCode });
            }
          } catch (switchError) {
            logger.error('Failed to switch AM Platinum dealer; skipping dealer', {
              dealerCode,
              error: switchError.message
            });
            summary.push({ dealerCode, status: 'dealer_switch_failed', error: switchError.message });
            activeDealerCode = null;
            continue;
          }
        }

        currentSession = await ensureSession(sessionRef, account);

        try {
          const result = await downloadHyundaiEnquiryReport(currentSession.page, {
            dealerCode,
            account,
            startDate: START_DATE,
            endDate: END_DATE
          });
          logger.info('AM Platinum Enquiry Report finished for dealer', { dealerCode, result });
          summary.push({ dealerCode, status: 'completed', rowCount: result?.rowCount ?? 0 });
        } catch (reportError) {
          logger.error('AM Platinum Enquiry Report failed for dealer', {
            dealerCode,
            error: reportError.message
          });
          summary.push({ dealerCode, status: 'failed', error: reportError.message });
        }
      }
    } catch (groupError) {
      logger.error('Failed AM Platinum Enquiry Report run group', {
        accountKey: group.accountKey,
        error: groupError.message
      });
    } finally {
      if (session?.browser) {
        await session.browser.close().catch(() => {});
      }
    }
  }

  logger.info('AM Platinum Enquiry Report run complete', {
    startDate: START_DATE,
    endDate: END_DATE,
    summary
  });
}

main().then(() => process.exit(0)).catch(err => {
  logger.error('Fatal error in AM Platinum Enquiry Report runner', err);
  process.exit(1);
});

// Runs the HIIB (ha.hiib.in) Hyundai Insurance Policy Summary Report once.
//
//   npm run hiib:insurance:once
//   npm run hiib:insurance:once -- --from=2026-06-01 --to=2026-07-25
//
// Flow: login -> sidebar Reports/MIS > Report > Policy Summary Report -> set the
// 60-day window -> Search -> page length 100 -> Export CSV (falls back to walking
// the paginated grid) -> save to Supabase.
//
// Flags:
//   --from=YYYY-MM-DD  window start (default: configured backfill start)
//   --to=YYYY-MM-DD    window end   (default: today)
//   --days=N           rolling window: start N days back from today. Ignored when --from
//                      is given. Used by the daily PM2 cron so it refreshes recent policies
//                      instead of re-scraping the whole backfill every night.
//   --dealer=N5203     only useful for logins not locked to one dealer
//   --captcha=manual   type the captcha yourself instead of auto-solving
//   --headless         run without a visible browser

import { createHiibAccountProfile } from '../src/accounts/hiib-accounts.js';
import { loginToHiibPortal } from '../src/auth/hiib-login.js';
import { config } from '../src/config.js';
import { downloadHyundaiInsuranceReport } from '../src/reports/hyundai-insurance-report.js';
import { logger } from '../src/utils/logger.js';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

// Passed through explicitly rather than via REPORT_DATE_OVERRIDE_* env vars:
// config.js is evaluated during module hoisting, before this file's body runs.
function rollingWindowStart(days) {
  const parsed = Number.parseInt(days, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const date = new Date();
  date.setDate(date.getDate() - parsed);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

// Computed per run, not baked into the PM2 config — ecosystem.config.cjs is evaluated once
// at `pm2 start`, so a date literal there would freeze at deploy time.
const fromDate = argValue('from') ?? rollingWindowStart(argValue('days'));
const toDate = argValue('to');
const dealerCode = argValue('dealer');
const captchaMode = argValue('captcha', config.hiibCaptchaMode);
const headless = process.argv.includes('--headless');
// Rows come from the DataTables grid by default; --export opts back into the
// CSV download, which the portal limits to ~3 per day.
const useCsvExport = process.argv.includes('--export');
const accountId = argValue('account', 'hiib');

async function main() {
  logger.info('Starting Hyundai Insurance Policy Summary Report run', {
    fromDate: fromDate ?? '(configured backfill start)',
    toDate: toDate ?? '(today)',
    account: accountId,
    dealerCode: dealerCode ?? '(login default)',
    chunkDays: config.hyundaiInsuranceReportChunkDays,
    source: useCsvExport ? 'csv-export' : 'dom-grid',
    captchaMode,
    headless
  });

  const account = createHiibAccountProfile(accountId);
  logger.info('Using HIIB account', { account: account.id, label: account.label, sheetName: account.sheetName });

  const session = await loginToHiibPortal({ headless, captchaMode, account });

  try {
    const result = await downloadHyundaiInsuranceReport(session.page, {
      dealerCode,
      account,
      startDate: fromDate,
      endDate: toDate,
      useCsvExport
    });
    logger.info('Hyundai Insurance Policy Summary Report finished', result);
  } finally {
    await session.close().catch(() => {});
  }
}

main().catch(error => {
  logger.error('Hyundai Insurance Policy Summary Report run failed', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});

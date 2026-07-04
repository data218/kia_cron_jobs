import 'dotenv/config';
import { config } from '../src/config.js';
import {
  applyHistoricalRunOptions,
  createAmPlatinumAccount,
  createAmPlatinumAccountForRange,
  describeAmPlatinumLoginPlan,
  resolveAmPlatinumDealerForFetch
} from '../src/accounts/am-platinum-accounts.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import {
  buildMissingComparableRanges,
  buildRangeFromIsoDates,
  defaultDealerCodes,
  getCurrentYearToDateRange,
  getLastYearComparableRange
} from '../src/am-platinum/comparable-period.js';
import { refreshAmPlatinumMaterializedViews } from '../src/supabase/materialized-views.js';
import { withPostgresClient } from '../src/supabase/postgres.js';
import { executeWithRetry } from '../src/utils/execute-with-retry.js';
import { retry } from '../src/utils/retry.js';
import { exportOperationWiseRangesForDealer } from '../src/reports/am-platinum-operation-wise-export.js';
import { validateAmPlatinumOperationWiseUpload } from './validate-am-platinum-operation-wise-upload.js';

function parseArgs(argv) {
  const options = {
    dealers: defaultDealerCodes(),
    cyStart: null,
    cyEnd: null,
    cyOnly: false,
    lyOnly: false,
    refreshMv: true,
    skipExisting: true
  };

  for (const arg of argv) {
    if (arg.startsWith('--dealer=')) {
      options.dealers = [arg.slice('--dealer='.length).trim().toUpperCase()];
    } else if (arg.startsWith('--dealers=')) {
      options.dealers = arg.slice('--dealers='.length).split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
    } else if (arg.startsWith('--cy-start=')) {
      options.cyStart = arg.slice('--cy-start='.length).trim();
    } else if (arg.startsWith('--cy-end=')) {
      options.cyEnd = arg.slice('--cy-end='.length).trim();
    } else if (arg === '--cy-only') {
      options.cyOnly = true;
      options.lyOnly = false;
    } else if (arg === '--ly-only') {
      options.lyOnly = true;
      options.cyOnly = false;
    } else if (arg === '--no-refresh-mv') {
      options.refreshMv = false;
    } else if (arg === '--force') {
      options.skipExisting = false;
    }
  }

  const cyRange = getCurrentYearToDateRange();
  options.cyStart = options.cyStart || cyRange.startIso;
  options.cyEnd = options.cyEnd || cyRange.endIso;

  return options;
}

function createAccount() {
  return applyHistoricalRunOptions(createAmPlatinumAccount('current'));
}

function resolveRangesForDealer(options, missingRanges) {
  const cyRange = buildRangeFromIsoDates(options.cyStart, options.cyEnd);
  const lyRange = getLastYearComparableRange(options.cyStart, options.cyEnd);

  if (options.cyOnly) {
    return [cyRange];
  }

  if (options.lyOnly) {
    return [lyRange];
  }

  return missingRanges.length ? missingRanges : [cyRange, lyRange];
}

function pickLoginRange(ranges) {
  return ranges.reduce((earliest, range) =>
    range.startIso < earliest.startIso ? range : earliest, ranges[0]);
}

async function loginSession(account, label) {
  return retry(
    async () => loginToHmilDms(account),
    {
      attempts: config.loginRetries + 1,
      delayMs: config.retryDelayMs,
      label
    }
  );
}

async function switchToDealer(page, dealerCode, account) {
  await changeActiveDealerForDms(page, dealerCode, {
    homeUrl: account.homeUrl,
    systemLabel: account.systemLabel
  });
}

export async function backfillComparableSlices(options) {
  const account = createAccount();
  const lyRange = getLastYearComparableRange(options.cyStart, options.cyEnd);
  const missingByDealer = await withPostgresClient(async client => {
    const map = new Map();

    for (const dealerCode of options.dealers) {
      map.set(
        dealerCode,
        await buildMissingComparableRanges(client, {
          dealerCode,
          cyStartIso: options.cyStart,
          cyEndIso: options.cyEnd
        })
      );
    }

    return map;
  });

  console.log('');
  console.log('='.repeat(80));
  console.log('  AM Platinum Operation Wise Comparable Slice Backfill');
  console.log('='.repeat(80));
  console.log(`  Dealers: ${options.dealers.join(', ')}`);
  console.log(`  CY window: ${options.cyStart} to ${options.cyEnd}`);
  console.log(`  LY window: ${lyRange.startIso} to ${lyRange.endIso}`);
  console.log(`  Mode: ${options.lyOnly ? 'LY only' : options.cyOnly ? 'CY only' : 'missing CY + LY per dealer'}`);
  console.log(`  ${describeAmPlatinumLoginPlan(options.cyStart, options.cyEnd, options.dealers)}`);
  console.log('');

  for (const dealerCode of options.dealers) {
    const missing = missingByDealer.get(dealerCode) ?? [];
    const ranges = resolveRangesForDealer(options, missing);
    console.log(`  ${dealerCode}: will upload ${ranges.map(range => `${range.startIso} to ${range.endIso}`).join(' | ') || 'nothing'}`);
  }
  console.log('');

  let session = null;

  try {
    for (const dealerCode of options.dealers) {
      const missing = missingByDealer.get(dealerCode) ?? [];
      const ranges = resolveRangesForDealer(options, missing);

      if (!ranges.length) {
        console.log(`Dealer ${dealerCode}: all comparable slices already present, skipping portal run.`);
        console.log('');
        continue;
      }

      const loginRange = pickLoginRange(ranges);
      const { accountKey, account: rangeAccount } = createAmPlatinumAccountForRange(loginRange, dealerCode);
      const fetchDealerCode = resolveAmPlatinumDealerForFetch(dealerCode, loginRange);
      const loginAccount = { ...rangeAccount, ...account, userId: rangeAccount.userId, password: rangeAccount.password };

      console.log(`Dealer ${dealerCode} (${accountKey}, fetch as ${fetchDealerCode})`);

      session = await loginSession(loginAccount, `AM Platinum comparable slice login for ${dealerCode}`);
      await switchToDealer(session.page, fetchDealerCode, loginAccount);

      const results = await executeWithRetry({
        name: `AM Platinum operation wise comparable slice ${dealerCode}`,
        page: session.page,
        fn: async () => exportOperationWiseRangesForDealer(session.page, {
          dealerCode,
          ranges,
          skipExisting: options.skipExisting
        })
      });

      for (const result of results) {
        const label = `${result.reportType} ${result.range.startIso} to ${result.range.endIso}`;
        if (result.action === 'skipped_existing') {
          console.log(`  SKIP existing ${label} (${result.rowCount} rows)`);
        } else if (result.action === 'no_rows') {
          console.log(`  EMPTY ${label}`);
        } else {
          console.log(`  SAVED ${label}: ${result.insertedRowCount ?? result.rowCount} rows`);
        }
      }

      await session.close().catch(() => {});
      session = null;
      console.log('');
    }
  } finally {
    await session?.close?.().catch(() => {});
  }

  if (options.refreshMv) {
    console.log('Refreshing am_platinum_vas_period_summary_v1...');
    await refreshAmPlatinumMaterializedViews();
  }

  console.log('Running post-backfill validation for all dealers...');
  const validation = await validateAmPlatinumOperationWiseUpload({
    dealers: options.dealers,
    cyStart: options.cyStart,
    cyEnd: options.cyEnd,
    refreshMv: false
  });

  if (!validation.pass) {
    process.exitCode = 1;
  }

  return validation;
}

const isMain = process.argv[1]?.includes('backfill-am-platinum-operation-wise-ly-slice.js');
if (isMain) {
  backfillComparableSlices(parseArgs(process.argv.slice(2))).catch(error => {
    console.error('Comparable slice backfill failed:', error);
    process.exitCode = 1;
  });
}

export { backfillComparableSlices as backfillLySlice };

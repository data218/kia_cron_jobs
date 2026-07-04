import 'dotenv/config';
import { config } from '../src/config.js';
import {
  applyHistoricalRunOptions,
  createAmPlatinumAccount,
  createAmPlatinumAccountForRange,
  describeAmPlatinumLoginPlan,
  resolveAmPlatinumAccountKeyForRange,
  resolveAmPlatinumDealerForFetch
} from '../src/accounts/am-platinum-accounts.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import {
  buildAllMissingComparableRanges,
  buildMonthlyComparableCyWindows,
  defaultDealerCodes,
  getLastYearComparableRange
} from '../src/am-platinum/comparable-period.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { exportOperationWiseRangesForDealer } from '../src/reports/am-platinum-operation-wise-export.js';
import { refreshAmPlatinumMaterializedViews } from '../src/supabase/materialized-views.js';
import { withPostgresClient } from '../src/supabase/postgres.js';
import { toIsoDate } from '../src/utils/date-range.js';
import { executeWithRetry } from '../src/utils/execute-with-retry.js';
import { retry } from '../src/utils/retry.js';
import { validateAmPlatinumOperationWiseUpload } from './validate-am-platinum-operation-wise-upload.js';

function currentYearStartIso(today = new Date()) {
  return `${today.getFullYear()}-01-01`;
}

function parseArgs(argv) {
  const today = new Date();
  const options = {
    dealers: defaultDealerCodes(),
    fromIso: currentYearStartIso(today),
    toIso: toIsoDate(today),
    cyOnly: false,
    lyOnly: false,
    refreshMv: true,
    skipExisting: true,
    validateAfter: true
  };

  for (const arg of argv) {
    if (arg.startsWith('--dealer=')) {
      options.dealers = [arg.slice('--dealer='.length).trim().toUpperCase()];
    } else if (arg.startsWith('--dealers=')) {
      options.dealers = arg.slice('--dealers='.length).split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
    } else if (arg.startsWith('--from=')) {
      options.fromIso = arg.slice('--from='.length).trim();
    } else if (arg.startsWith('--to=')) {
      options.toIso = arg.slice('--to='.length).trim();
    } else if (arg === '--cy-only') {
      options.cyOnly = true;
      options.lyOnly = false;
    } else if (arg === '--ly-only') {
      options.lyOnly = true;
      options.cyOnly = false;
    } else if (arg === '--no-refresh-mv') {
      options.refreshMv = false;
    } else if (arg === '--no-validate') {
      options.validateAfter = false;
    } else if (arg === '--force') {
      options.skipExisting = false;
    }
  }

  return options;
}

function createAccount() {
  return applyHistoricalRunOptions(createAmPlatinumAccount('current'));
}

function pickLoginRange(ranges) {
  return ranges.reduce((earliest, range) =>
    range.startIso < earliest.startIso ? range : earliest, ranges[0]);
}

function groupRangesByAccountKey(ranges, dealerCode) {
  const groups = new Map();

  for (const range of ranges) {
    const accountKey = resolveAmPlatinumAccountKeyForRange(range, dealerCode);
    if (!groups.has(accountKey)) {
      groups.set(accountKey, []);
    }
    groups.get(accountKey).push(range);
  }

  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
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

async function loadMissingByDealer(options) {
  return withPostgresClient(async client => {
    const map = new Map();

    for (const dealerCode of options.dealers) {
      map.set(
        dealerCode,
        await buildAllMissingComparableRanges(client, {
          dealerCode,
          fromIso: options.fromIso,
          toIso: options.toIso,
          cyOnly: options.cyOnly,
          lyOnly: options.lyOnly
        })
      );
    }

    return map;
  });
}

function printPlan(options, missingByDealer) {
  const windows = buildMonthlyComparableCyWindows(options.fromIso, options.toIso);
  const totalRanges = [...missingByDealer.values()].reduce((sum, ranges) => sum + ranges.length, 0);

  console.log('');
  console.log('='.repeat(88));
  console.log('  AM Platinum Operation Wise — Fix ALL Comparable CY + LY Slices');
  console.log('='.repeat(88));
  console.log(`  Dealers: ${options.dealers.join(', ')}`);
  console.log(`  CY span: ${options.fromIso} to ${options.toIso} (${windows.length} month windows)`);
  console.log(`  Mode: ${options.lyOnly ? 'LY only' : options.cyOnly ? 'CY only' : 'missing CY + LY'}`);
  console.log(`  Missing portal uploads queued: ${totalRanges}`);
  console.log(`  ${describeAmPlatinumLoginPlan(options.fromIso, options.toIso, options.dealers)}`);
  console.log('');

  for (const dealerCode of options.dealers) {
    const ranges = missingByDealer.get(dealerCode) ?? [];
    console.log(`  ${dealerCode}: ${ranges.length} range(s)`);
    for (const range of ranges) {
      console.log(`    - ${range.startIso} to ${range.endIso}`);
    }
  }

  console.log('');
}

async function runDealerUploads(dealerCode, ranges, options, account) {
  const batches = groupRangesByAccountKey(ranges, dealerCode);

  for (const [accountKey, batchRanges] of batches) {
    const loginRange = pickLoginRange(batchRanges);
    const { account: rangeAccount } = createAmPlatinumAccountForRange(loginRange, dealerCode);
    const fetchDealerCode = resolveAmPlatinumDealerForFetch(dealerCode, loginRange);
    const loginAccount = {
      ...rangeAccount,
      ...account,
      userId: rangeAccount.userId,
      password: rangeAccount.password
    };

    console.log(`Dealer ${dealerCode} batch (${accountKey}, fetch as ${fetchDealerCode}, ${batchRanges.length} range(s))`);

    let session = null;

    try {
      session = await loginSession(
        loginAccount,
        `AM Platinum all-comparable login for ${dealerCode} (${accountKey})`
      );
      await switchToDealer(session.page, fetchDealerCode, loginAccount);

      const results = await executeWithRetry({
        name: `AM Platinum operation wise all-comparable ${dealerCode}`,
        page: session.page,
        fn: async () => exportOperationWiseRangesForDealer(session.page, {
          dealerCode,
          ranges: batchRanges,
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
    } finally {
      await session?.close?.().catch(() => {});
    }

    console.log('');
  }
}

async function validateAllWindows(options) {
  const windows = buildMonthlyComparableCyWindows(options.fromIso, options.toIso);
  let allPass = true;

  console.log('Post-backfill validation (every month window):');
  console.log('');

  for (const window of windows) {
    const validation = await validateAmPlatinumOperationWiseUpload({
      dealers: options.dealers,
      cyStart: window.cyStartIso,
      cyEnd: window.cyEndIso,
      refreshMv: false
    });

    const lyRange = getLastYearComparableRange(window.cyStartIso, window.cyEndIso);
    const status = validation.pass ? 'PASS' : 'FAIL';
    if (!validation.pass) {
      allPass = false;
    }

    console.log(
      `  ${window.label}: ${status} | CY ${window.cyStartIso} to ${window.cyEndIso} | LY ${lyRange.startIso} to ${lyRange.endIso}`
    );

    if (!validation.pass) {
      for (const dealer of validation.dealers.filter(entry => !entry.pass)) {
        console.log(`    ${dealer.dealerCode}: ${dealer.blockingIssues.join('; ')}`);
      }
    }
  }

  console.log('');
  console.log(`Overall: ${allPass ? 'PASS' : 'FAIL'}`);
  console.log('');

  return allPass;
}

export async function backfillAllComparableSlices(options) {
  const account = createAccount();
  const missingByDealer = await loadMissingByDealer(options);
  printPlan(options, missingByDealer);

  const dealersWithWork = options.dealers.filter(dealerCode => (missingByDealer.get(dealerCode) ?? []).length);

  if (!dealersWithWork.length) {
    console.log('Nothing missing — all comparable CY + LY slices already present.');
  } else {
    for (const dealerCode of dealersWithWork) {
      await runDealerUploads(dealerCode, missingByDealer.get(dealerCode), options, account);
    }
  }

  if (options.refreshMv) {
    console.log('Refreshing am_platinum_vas_period_summary_v1...');
    await refreshAmPlatinumMaterializedViews();
  }

  if (options.validateAfter) {
    const pass = await validateAllWindows(options);
    if (!pass) {
      process.exitCode = 1;
    }
    return { pass };
  }

  return { pass: true };
}

const isMain = process.argv[1]?.includes('backfill-am-platinum-operation-wise-all-comparable.js');
if (isMain) {
  backfillAllComparableSlices(parseArgs(process.argv.slice(2))).catch(error => {
    console.error('All-comparable backfill failed:', error);
    process.exitCode = 1;
  });
}

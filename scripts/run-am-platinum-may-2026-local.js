import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../src/utils/logger.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { createAmPlatinumAccount } from '../src/accounts/am-platinum-accounts.js';
import { openRoBillingReport, openAdvWiseLubricantsVasReport, openOpenRoYearlyReport } from '../src/navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../src/playwright/frame-resolver.js';
import { exportAllGridPagesToFiles } from '../src/reports/paged-export.js';
import { selectKendoPagerSizeWithPreferredFallback, waitForKendoGridIdle } from '../src/reports/grid.js';
import { clickSearch, fillDate, selectKendoDropdownByInputId } from '../src/reports/report-actions.js';

const OUTPUT_ROOT = path.resolve('output/am-platinum-may-2026');

const MAY_RANGE = {
  startPortal: '01/05/2026',
  endPortal: '31/05/2026',
  startIso: '2026-05-01',
  endIso: '2026-05-31'
};

async function exportReport({ page, label, navigateFn, contextSelector, extraSetup, dateFillFn }) {
  const dirName = label.toLowerCase().replace(/\s+/g, '-');
  const reportDir = path.join(OUTPUT_ROOT, dirName);
  await fs.mkdir(reportDir, { recursive: true });

  logger.info(`[${label}] Navigating...`);
  await navigateFn(page);

  logger.info(`[${label}] Resolving context...`);
  const context = await findContextWithVisibleSelector(page, contextSelector, {
    timeout: 90000,
    label
  });

  if (extraSetup) {
    logger.info(`[${label}] Running extra setup...`);
    await extraSetup(context);
  }

  logger.info(`[${label}] Filling dates ${MAY_RANGE.startPortal} - ${MAY_RANGE.endPortal}...`);
  await dateFillFn(context);

  logger.info(`[${label}] Clicking Search...`);
  await clickSearch(context);
  await waitForKendoGridIdle(context, { timeout: 120000 });

  logger.info(`[${label}] Setting page size...`);
  const pageSize = await selectKendoPagerSizeWithPreferredFallback(context, ['1000', '500', '300']);

  logger.info(`[${label}] Exporting all pages...`);
  const pageFiles = await exportAllGridPagesToFiles(context, {
    outputDir: reportDir,
    filenameBase: dirName,
    pageSize,
    maxPages: 500
  });

  logger.info(`[${label}] Done — ${pageFiles.length} files → ${reportDir}`);
  return { label, reportDir, pageFiles };
}

async function main() {
  logger.info('=== AM Platinum May 2026 — Local Excel Export (no DB) ===');
  const account = createAmPlatinumAccount('current');
  logger.info(`Account: ${account.userId}`);

  logger.info('Logging in...');
  const session = await loginToHmilDms(account);
  const { page } = session;

  const results = [];
  const reportConfigs = [
    {
      label: 'Repair Order List',
      navigateFn: openOpenRoYearlyReport,
      contextSelector: '#sRoDateFromDate',
      dateFillFn: async ctx => {
        await fillDate(ctx, '#sRoDateToDate', MAY_RANGE.endPortal);
        await fillDate(ctx, '#sRoDateFromDate', MAY_RANGE.startPortal);
      }
    },
    {
      label: 'RO Billing',
      navigateFn: openRoBillingReport,
      contextSelector: '#sBillDateFromDate',
      dateFillFn: async ctx => {
        await fillDate(ctx, '#sBillDateToDate', MAY_RANGE.endPortal);
        await fillDate(ctx, '#sBillDateFromDate', MAY_RANGE.startPortal);
      }
    },
    {
      label: 'Operation Wise',
      navigateFn: openAdvWiseLubricantsVasReport,
      contextSelector: '#startDate',
      extraSetup: async ctx => {
        await selectKendoDropdownByInputId(ctx, 'dateType', 'Billing Date');
        const reportTypeInput = ctx.locator('#reportType');
        if (await reportTypeInput.count().catch(() => 0)) {
          await selectKendoDropdownByInputId(ctx, 'reportType', 'Operation');
        }
      },
      dateFillFn: async ctx => {
        await fillDate(ctx, '#endDate', MAY_RANGE.endPortal);
        await fillDate(ctx, '#startDate', MAY_RANGE.startPortal);
      }
    },
    {
      label: 'Adv Wise Lubricants VAS',
      navigateFn: openAdvWiseLubricantsVasReport,
      contextSelector: '#startDate',
      extraSetup: async ctx => {
        await selectKendoDropdownByInputId(ctx, 'dateType', 'Billing Date');
      },
      dateFillFn: async ctx => {
        await fillDate(ctx, '#endDate', MAY_RANGE.endPortal);
        await fillDate(ctx, '#startDate', MAY_RANGE.startPortal);
      }
    }
  ];

  for (const cfg of reportConfigs) {
    try {
      results.push(await exportReport({ page, ...cfg }));
    } catch (err) {
      logger.error(`[${cfg.label}] FAILED`, err);
      results.push({ label: cfg.label, error: err.message });
    }
  }

  logger.info('=== All done ===');
  console.log('\nOutput files:');
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.label}: FAILED - ${r.error}`);
    } else {
      console.log(`  ${r.label}: ${r.reportDir}/ (${r.pageFiles.length} files)`);
    }
  }
  const ok = results.filter(r => !r.error);
  console.log(`\nSucceeded: ${ok.length}/${reportConfigs.length}, total files: ${ok.reduce((s, r) => s + r.pageFiles.length, 0)}`);
  await session.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

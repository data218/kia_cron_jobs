import assert from 'node:assert/strict';

process.env.DRY_RUN_REPORTS = 'true';
process.env.HMIL_USER_ID = 'sahiltech';
process.env.HMIL_PASSWORD = 'test-primary';
process.env.HMIL_SECONDARY_USER_ID = 'MIS5216';
process.env.HMIL_SECONDARY_PASSWORD = 'test-secondary';
process.env.HMIL_DEALER_CODES = 'N5203,N5701';
process.env.HMIL_WARRANTY_SECONDARY_DEALER_CODES = 'N5216,N6844,N6845,N6846,N6847,N6848';
process.env.LOGIN_RETRIES = '0';
process.env.REPORT_MAX_RETRIES = '1';
process.env.REPORT_RETRY_DELAY_MIN_MS = '0';
process.env.REPORT_RETRY_DELAY_MAX_MS = '0';
process.env.ALERT_EMAIL_FROM = '';
process.env.ALERT_EMAIL_TO = '';
process.env.ALERT_EMAIL_APP_PASSWORD = '';

const { createHmilWarrantyAccounts } = await import('../accounts/hmil-warranty-accounts.js');
const {
  getHmilWarrantyRange,
  hmilWarrantyReportDefinitions
} = await import('../reports/hmil-warranty-reports.js');
const {
  executeHmilWarrantySequence,
  getWarrantyDealerCodesForAccount,
  runHmilWarrantyJob
} = await import('./hmil-warranty-scheduler.js');
const { reportRowSignature, rowSignature } = await import('../supabase/relational-store.js');

const accounts = createHmilWarrantyAccounts();
assert.deepEqual(accounts.map(account => account.userId), ['sahiltech', 'MIS5216']);
assert.notEqual(accounts[0].sessionStatePath, accounts[1].sessionStatePath);

assert.deepEqual(getWarrantyDealerCodesForAccount(accounts[0]), ['N5203', 'N5701']);
assert.deepEqual(
  getWarrantyDealerCodesForAccount(accounts[1]),
  ['N5216', 'N6844', 'N6845', 'N6846', 'N6847', 'N6848']
);

const scheduled = getHmilWarrantyRange('scheduled', new Date(2026, 5, 12));
assert.equal(scheduled.startIso, '2025-01-01');
assert.equal(scheduled.endIso, '2026-06-12');

const historical = getHmilWarrantyRange('historical', new Date(2026, 5, 12));
assert.equal(historical.startIso, '2025-01-01');
assert.equal(historical.endIso, '2026-06-12');

assert.throws(() => getHmilWarrantyRange('current-month'), /Unknown HMIL warranty mode/);

assert.equal(
  rowSignature({ 'Claim No.': 'C-1', source_login_id: 'sahiltech' }),
  rowSignature({ 'Claim No.': 'C-1', source_login_id: 'MIS5216' })
);
assert.equal(
  reportRowSignature('Hyundai Warranty Claim YTP', {
    'Claim No.': 'C-1',
    Status: 'Pending',
    source_login_id: 'sahiltech'
  }),
  reportRowSignature('Hyundai Warranty Claim YTP', {
    'Claim No.': 'C-1',
    Status: 'Approved',
    source_login_id: 'MIS5216'
  })
);
assert.equal(
  reportRowSignature('Hyundai Warranty Claim List', {
    'Claim No.': 'C-2',
    source_login_id: 'sahiltech'
  }),
  reportRowSignature('Hyundai Warranty Claim List', {
    'Claim Number': 'C-2',
    source_login_id: 'MIS5216'
  })
);

assert.equal(hmilWarrantyReportDefinitions[0].id, 'hyundai-warranty-claim-list');
assert.equal(hmilWarrantyReportDefinitions[1].id, 'hyundai-warranty-claim-ytp');
assert.equal(hmilWarrantyReportDefinitions[1].dateToSelector, '#sRoToDate');

const results = await runHmilWarrantyJob('scheduled', {
  accounts,
  reports: hmilWarrantyReportDefinitions,
  dryRun: true,
  skipTableClear: true
});

assert.equal(results.length, 16);
assert.deepEqual(
  results.map(result => `${result.sourceLoginId}:${result.dealerCode}:${result.reportId}`),
  [
    'sahiltech:N5203:hyundai-warranty-claim-list',
    'sahiltech:N5203:hyundai-warranty-claim-ytp',
    'sahiltech:N5701:hyundai-warranty-claim-list',
    'sahiltech:N5701:hyundai-warranty-claim-ytp',
    'MIS5216:N5216:hyundai-warranty-claim-list',
    'MIS5216:N5216:hyundai-warranty-claim-ytp',
    'MIS5216:N6844:hyundai-warranty-claim-list',
    'MIS5216:N6844:hyundai-warranty-claim-ytp',
    'MIS5216:N6845:hyundai-warranty-claim-list',
    'MIS5216:N6845:hyundai-warranty-claim-ytp',
    'MIS5216:N6846:hyundai-warranty-claim-list',
    'MIS5216:N6846:hyundai-warranty-claim-ytp',
    'MIS5216:N6847:hyundai-warranty-claim-list',
    'MIS5216:N6847:hyundai-warranty-claim-ytp',
    'MIS5216:N6848:hyundai-warranty-claim-list',
    'MIS5216:N6848:hyundai-warranty-claim-ytp'
  ]
);

const failureResults = await executeHmilWarrantySequence({
  mode: 'historical',
  accounts,
  reports: hmilWarrantyReportDefinitions,
  dealerCodesByAccount: {
    sahiltech: ['active'],
    MIS5216: ['active']
  },
  login: async account => {
    if (account.userId === 'sahiltech') {
      throw new Error('simulated primary login failure');
    }
    return {
      page: { url: () => 'https://ndms.hmil.net/cmm/cmmd/selectHome.dms' },
      close: async () => {}
    };
  },
  runReport: async (_page, { account, report }) => {
    if (report.id === 'hyundai-warranty-claim-ytp') {
      throw new Error('simulated report failure');
    }
    return {
      name: report.name,
      id: report.id,
      sheetName: report.sheetName,
      sourceLoginId: account.userId,
      dealerCode: 'active',
      dbResult: { action: 'simulated', rowCount: 1 }
    };
  }
});

assert.equal(failureResults.length, 4);
assert.equal(failureResults.filter(result => result.phase === 'login').length, 2);
assert.equal(failureResults.filter(result => result.status === 'failed' && !result.phase).length, 1);
assert.equal(failureResults.filter(result => result.status === 'success').length, 1);

console.log('HMIL warranty dry-run tests passed');

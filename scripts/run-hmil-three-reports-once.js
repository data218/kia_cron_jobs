// One-shot script: Run RO Billing, Repair Order, and Operation Wise for current month
// Uses new credentials (MIS5216) and new dealer codes
// After this completes, the normal cron schedule takes over automatically

// Force new credentials and new dealer codes
process.env.HMIL_USER_ID = 'MIS5216';
process.env.HMIL_PASSWORD = 'Singh@321';
process.env.HMIL_DEALER_CODES = 'N5216,N6844,N6845,N6846,N6847,N6848';
process.env.HMIL_CURRENT_MONTH_ONLY = 'true';

// Only run the 3 requested reports
process.env.HMIL_REPORTS_TO_RUN = 'hyundai-ro-billing-report,hyundai-repair-order-list,hyundai-operation-wise-analysis-report';

const { createGdmsAccountScheduler } = await import('../src/cron/gdms-account-scheduler.js');
const { createGdmsAccountProfile } = await import('../src/accounts/gdms-account-profile.js');

const account = createGdmsAccountProfile('hmil');

console.log('=== HMIL One-Shot: 3 Reports for Current Month ===');
console.log(`User ID: ${account.userId}`);
console.log(`Dealers: ${account.dealerCodes.join(', ')}`);
console.log(`Reports: ${account.reportsToRun}`);
console.log(`Current Month Only: ${account.currentMonthOnly}`);
console.log('Starting now...\n');

const scheduler = createGdmsAccountScheduler(account);
await scheduler.run(account.defaultMode);

console.log('\n=== Done! Normal cron schedule will take over. ===');

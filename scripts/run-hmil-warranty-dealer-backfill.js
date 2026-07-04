import { createHmilWarrantyAccounts } from '../src/accounts/hmil-warranty-accounts.js';
import { runHmilWarrantyJob } from '../src/cron/hmil-warranty-scheduler.js';

const dealerCode = String(process.argv[2] || 'N5203').trim().toUpperCase();
const accounts = createHmilWarrantyAccounts();
const primary = accounts.find(account => account.id === 'hmil-warranty-primary');

if (!primary) {
  throw new Error('Could not resolve hmil-warranty-primary (sahiltech) account');
}

process.env.HEADLESS = 'false';
process.env.OTP_PROVIDER = process.env.OTP_PROVIDER || 'manual';

console.log('');
console.log('HMIL Warranty targeted dealer backfill');
console.log(`Dealer: ${dealerCode}`);
console.log(`Login: ${primary.userId}`);
console.log('Reports: Claim List + Claim YTP');
console.log('Table clear: skipped (other dealers kept)');
console.log('Type OTP in this terminal when prompted.');
console.log('');

await runHmilWarrantyJob('historical', {
  accounts: [primary],
  dealerCodesByAccount: {
    [primary.userId]: [dealerCode]
  },
  skipTableClear: true
});

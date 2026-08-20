// Interakt social-media lead capture — one pass.
//
// First run MUST be visible so the WhatsApp OTP can be typed in:
//   node scripts/run-interakt-leads-once.js
// After the session is saved, the PM2 cron runs it headless every 10 minutes.
import { runInteraktLeadCapture } from '../src/reports/interakt-leads.js';
import { logger } from '../src/utils/logger.js';

const headless = process.argv.includes('--headless');
const maxFlag = process.argv.find(a => a.startsWith('--max='));
const maxLeads = maxFlag ? Number.parseInt(maxFlag.slice(6), 10) : 100;

runInteraktLeadCapture({ headless, maxLeads })
  .then(result => logger.info('Interakt lead capture finished', result))
  .catch(error => {
    logger.error('Interakt lead capture failed', { error: error.message, stack: error.stack });
    process.exitCode = 1;
  });

// Interakt social-media lead capture — one pass.
//
// First run MUST be visible so the WhatsApp OTP can be typed in:
//   node scripts/run-interakt-leads-once.js
// After the session is saved, the PM2 cron runs it headless every 10 minutes.
import { runInteraktLeadCapture } from '../src/reports/interakt-leads.js';
import { logger } from '../src/utils/logger.js';

// Disabled on request (2026-09-04). The PM2 cron entries were left registered in a daemon whose
// CLI is currently unreachable, so the kill switch lives here where it cannot be bypassed: any
// firing exits before a browser is launched. Set INTERAKT_ENABLED=true to turn it back on.
const enabled = process.env.INTERAKT_ENABLED === 'true';

const headless = process.argv.includes('--headless');
const maxFlag = process.argv.find(a => a.startsWith('--max='));
const maxLeads = maxFlag ? Number.parseInt(maxFlag.slice(6), 10) : 100;

// Returning rather than process.exit() so pino finishes flushing; exiting mid-flush threw
// "sonic boom is not ready yet" over every skipped firing.
if (!enabled) {
  logger.warn('Interakt lead capture is DISABLED; exiting without running', {
    reason: 'INTERAKT_ENABLED is not set to "true"'
  });
} else {
  runInteraktLeadCapture({ headless, maxLeads })
    .then(result => logger.info('Interakt lead capture finished', result))
    .catch(error => {
      logger.error('Interakt lead capture failed', { error: error.message, stack: error.stack });
      process.exitCode = 1;
    });
}

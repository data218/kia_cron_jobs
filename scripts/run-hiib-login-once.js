// Logs into the HIIB insurance portal (ha.hiib.in) in a visible browser and holds
// the window open so the session can be inspected by hand.
//
//   npm run hiib:login              - auto-solves the captcha
//   npm run hiib:login:manual       - waits for you to type the captcha
//
// Flags:
//   --hold=<seconds>  how long to keep the browser open (default 300, 0 = until Enter)
//   --reuse           reuse a saved session instead of forcing a fresh login

import readline from 'node:readline';
import { loginToHiibPortal } from '../src/auth/hiib-login.js';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const holdSeconds = Number(argValue('hold', '300'));
const reuseSession = process.argv.includes('--reuse');
const captchaMode = argValue('captcha', config.hiibCaptchaMode);

/** Resolves on Enter or after the hold window, whichever comes first. */
function waitForUser(seconds) {
  return new Promise(resolve => {
    let timer = null;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const done = () => {
      if (timer) clearTimeout(timer);
      rl.close();
      resolve();
    };

    rl.question('\n>>> Browser is open. Press Enter here to close it...\n', done);

    if (seconds > 0) {
      timer = setTimeout(() => {
        logger.info('Hold window elapsed; closing browser', { seconds });
        done();
      }, seconds * 1000);
    }
  });
}

async function main() {
  logger.info('Opening HIIB portal login in a visible browser', {
    loginUrl: config.hiibLoginUrl,
    userId: config.hiibUserId,
    captchaMode,
    forceLogin: !reuseSession,
    holdSeconds
  });

  const session = await loginToHiibPortal({
    headless: false,
    forceLogin: !reuseSession,
    captchaMode
  });

  try {
    logger.info('Logged in', { url: session.page.url(), reusedSession: session.reusedSession });

    // Land on the report page so the session is visibly usable.
    await session.page.goto(config.hiibPolicySummaryReportUrl, { waitUntil: 'domcontentloaded' })
      .catch(error => logger.warn('Could not open the report page', { error: error.message }));

    logger.info('Current page', { url: session.page.url() });

    await waitForUser(holdSeconds);
  } finally {
    await session.close().catch(() => {});
    logger.info('Browser closed');
  }
}

main().catch(error => {
  logger.error('HIIB login run failed', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});

// Diagnoses why the July 2026 search returns few rows for N5203.
// Logs in, dumps every filter control on the report page, captures the exact
// payload sent to BindPolicySummaryList, and compares several date windows.
//
//   node scratch/diagnose-hiib-july.js

import { createHiibAccountProfile } from '../src/accounts/hiib-accounts.js';
import { loginToHiibPortal } from '../src/auth/hiib-login.js';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';
import { sleep } from '../src/utils/sleep.js';

const WINDOWS = [
  ['01/Jul/2026', '28/Jul/2026'],
  ['01/Jun/2026', '30/Jun/2026']
];

async function main() {
  const account = createHiibAccountProfile('hiib');
  const session = await loginToHiibPortal({ headless: true, account });
  const { page } = session;

  const posts = [];
  page.on('request', req => {
    if (req.url().includes('BindPolicySummaryList')) {
      posts.push({ url: req.url(), body: req.postData() });
    }
  });

  try {
    await page.goto(config.hiibPolicySummaryReportUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#PolicyCreatedDate').waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    // Every input/select on the form, with its current value - looks for a filter
    // left at a restrictive default.
    const controls = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#PolicySummaryForm input, #PolicySummaryForm select'))
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          name: el.getAttribute('name'),
          type: el.getAttribute('type'),
          disabled: el.disabled,
          value: (el.value ?? '').slice(0, 60),
          selectedText: el.tagName === 'SELECT'
            ? (el.options[el.selectedIndex]?.text ?? '').slice(0, 50)
            : undefined,
          optionCount: el.tagName === 'SELECT' ? el.options.length : undefined
        }))
    );
    console.log('\n=== FORM CONTROLS ===');
    for (const c of controls) console.log(JSON.stringify(c));

    for (const [from, to] of WINDOWS) {
      posts.length = 0;
      await page.evaluate(({ f, t }) => {
        const set = (id, v) => {
          const el = document.getElementById(id);
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('PolicyCreatedDate', f);
        set('PolicyCreatedTo', t);
      }, { f: from, t: to });

      await page.click('#btnSearch');
      await sleep(6000);

      const info = await page.locator('#tblAllPayout_info').innerText().catch(() => '');
      const modal = await page.locator('#AlertMessageContact').innerText().catch(() => '');
      console.log(`\n=== ${from} -> ${to} ===`);
      console.log('grid info :', info.trim() || '(none)');
      if (modal.trim()) console.log('modal     :', modal.trim().slice(0, 160));
      const body = posts[0]?.body ?? ''; const parts = decodeURIComponent(body).split('&').filter(s => /Policy|Dealer|Insurance|Region|start=|length=/i.test(s)); console.log('filter params:', parts.join(' | ') || '(none captured)');
    }
  } finally {
    await session.close().catch(() => {});
  }
}

main().catch(e => {
  logger.error('diagnosis failed', { error: e.message, stack: e.stack });
  process.exitCode = 1;
});

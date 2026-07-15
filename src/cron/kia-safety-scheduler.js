import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { downloadKiaSafetyReport } from '../reports/kia-safety.js';
import { ensureRuntimeDirs } from '../utils/runtime-dirs.js';
import { logger } from '../utils/logger.js';
import { writeHealthStatus } from '../utils/health.js';
import { createSupabaseClient } from '../supabase/client.js';

async function fetchKiaCredentials() {
  try {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase
      .from('kia_credentials')
      .select('username, password')
      .eq('id', 1)
      .single();
    if (error || !data) {
      logger.info('No Supabase credentials found, using .env defaults');
      return;
    }
    logger.info('Loaded credentials from Supabase');
    process.env.KIA_SAFETY_USER_ID = data.username;
    process.env.KIA_SAFETY_PASSWORD = data.password;
  } catch (err) {
    logger.warn('Failed to fetch credentials from Supabase, using .env defaults', { error: err.message });
  }
}

async function runKiaSafetyDaily() {
  logger.info('Kia Safety daily D-1 job started');
  await ensureRuntimeDirs();

  // Fetch latest credentials from Supabase (overrides .env)
  await fetchKiaCredentials();

  // Ensure custom date range is NOT set — daily mode reads config
  delete process.env.KIA_SAFETY_FROM_DATE;
  delete process.env.KIA_SAFETY_TO_DATE;

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-gpu']
  });

  const context = await browser.newContext({ acceptDownloads: true });
  context.setDefaultTimeout(90000);
  const page = await context.newPage();
  page.on('dialog', async (d) => { await d.dismiss().catch(() => {}); });

  try {
    const result = await downloadKiaSafetyReport(page, { mode: 'kia-safety-daily' });
    logger.info('Kia Safety daily D-1 job completed', { result });
    await writeHealthStatus({ name: 'kia-safety-daily', status: 'ok', result });
  } catch (err) {
    logger.error('Kia Safety daily D-1 job failed', { error: err.message });
    await writeHealthStatus({ name: 'kia-safety-daily', status: 'failed', error: err.message });
    throw err;
  } finally {
    await browser.close();
  }
}

const shouldRunFromCli =
  path.resolve(process.argv[1] || '').toLowerCase() ===
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (shouldRunFromCli) {
  runKiaSafetyDaily().then(() => process.exit(0)).catch(() => process.exit(1));
}

export { runKiaSafetyDaily };

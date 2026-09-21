import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { downloadKiaSafetyReport } from '../reports/kia-safety.js';
import { ensureRuntimeDirs } from '../utils/runtime-dirs.js';
import { logger } from '../utils/logger.js';
import { writeHealthStatus } from '../utils/health.js';
import { createSupabaseClient } from '../supabase/client.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

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

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runKiaSafetyDaily() {
  logger.info('Kia Safety daily D-1 job started');
  await ensureRuntimeDirs();

  // Fetch latest credentials from Supabase (overrides .env)
  await fetchKiaCredentials();

  // Ensure custom date range is NOT set — daily mode reads config
  delete process.env.KIA_SAFETY_FROM_DATE;
  delete process.env.KIA_SAFETY_TO_DATE;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      const delay = RETRY_DELAY_MS * (attempt - 1);
      logger.info(`Retry attempt ${attempt}/${MAX_RETRIES} after ${delay}ms delay`);
      await sleepMs(delay);
    }

    let browser = null;
    try {
      browser = await chromium.launch({
        headless: process.env.HEADLESS !== 'false',
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions']
      });

      const context = await browser.newContext({ acceptDownloads: true });
      context.setDefaultTimeout(90000);
      const page = await context.newPage();
      page.on('dialog', async (d) => { await d.dismiss().catch(() => {}); });

      const result = await downloadKiaSafetyReport(page, { mode: 'kia-safety-daily' });
      logger.info('Kia Safety daily D-1 job completed', { result, attempt });
      await writeHealthStatus({ name: 'kia-safety-daily', status: 'ok', result });
      return;
    } catch (err) {
      lastError = err;
      logger.error(`Kia Safety daily D-1 job failed (attempt ${attempt}/${MAX_RETRIES})`, { error: err.message });
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  logger.error('Kia Safety daily D-1 job failed after all retries', { error: lastError.message });
  await writeHealthStatus({ name: 'kia-safety-daily', status: 'failed', error: lastError.message });
  throw lastError;
}

function isMainModule() {
  const argvPath = process.env.pm_exec_path || process.argv[1];
  if (!argvPath) return false;
  return path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(argvPath).toLowerCase();
}

if (isMainModule()) {
  runKiaSafetyDaily().then(() => process.exit(0)).catch(() => process.exit(1));
}

export { runKiaSafetyDaily };

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { analyzeAmPlatinumPerDealerCoverage } from './analyze-am-platinum-per-dealer-coverage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const STAGGER_MS = Number.parseInt(process.env.AM_PLATINUM_PARALLEL_STAGGER_MS ?? '60000', 10);
const LAUNCH_STATE_FILE = path.join(config.logsDir, 'am-platinum-parallel-historical-launch-state.json');
const SKIP_OPERATION_WISE = true;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugifyReportId(reportId) {
  return String(reportId).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function pm2NameForReport(reportId) {
  const slug = slugifyReportId(reportId);
  return `am-plat-hist-${slug}`.slice(0, 40);
}

function scriptForRunner(runner) {
  return runner === 'optimized-historical'
    ? 'scripts/run-am-platinum-optimized-backfill.js'
    : 'scripts/run-am-platinum-historical-backfill.js';
}

function runPm2(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pm2', args, {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
      shell: true
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pm2 ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

async function pm2AppExists(name) {
  return new Promise(resolve => {
    const child = spawn('pm2', ['jlist'], { cwd: projectRoot, shell: true });
    let output = '';

    child.stdout.on('data', chunk => {
      output += chunk.toString();
    });

    child.on('close', () => {
      try {
        const apps = JSON.parse(output);
        resolve(apps.some(app => app.name === name));
      } catch {
        resolve(false);
      }
    });

    child.on('error', () => resolve(false));
  });
}

async function stopSequentialPipeline() {
  try {
    await runPm2(['stop', 'am-platinum-historical-pipeline']);
    console.log('  Stopped am-platinum-historical-pipeline (parallel mode replaces sequential queue).');
  } catch {
    console.log('  am-platinum-historical-pipeline not running.');
  }
}

async function launchReport({ runner, reportId, dealers }, index, total) {
  const pm2Name = pm2NameForReport(reportId);
  const script = scriptForRunner(runner);
  const slug = slugifyReportId(reportId);
  const logOut = `./logs/pm2-${slug}-out.log`;
  const logErr = `./logs/pm2-${slug}-error.log`;

  if (await pm2AppExists(pm2Name)) {
    console.log(`  [${index + 1}/${total}] ${pm2Name} already registered — restarting.`);
    await runPm2(['restart', pm2Name], {
      AM_PLATINUM_HISTORICAL_REPORTS: reportId,
      AM_PLATINUM_HISTORICAL_DEALERS: dealers.join(','),
      AM_PLATINUM_HISTORICAL_START_DATE: '2021-01-01',
      AM_PLATINUM_HISTORICAL_HEADLESS: process.env.AM_PLATINUM_HISTORICAL_HEADLESS ?? 'false',
      AM_PLATINUM_HISTORICAL_FORCE_LOGIN: 'false',
      AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE: 'true',
      AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE: 'true',
      AM_PLATINUM_HISTORICAL_SKIP_EXISTING: 'false',
      AM_PLATINUM_HISTORICAL_STATE_FILE: `am-platinum-historical-${slug}-state.json`,
      AM_PLATINUM_HISTORICAL_LOG_PREFIX: `am-platinum-historical-${slug}`,
      LOG_SERVICE_NAME: pm2Name
    });
    return { pm2Name, reportId, dealers, runner, action: 'restarted' };
  }

  console.log(`  [${index + 1}/${total}] Launching ${pm2Name} (${reportId}) → dealers ${dealers.join(', ')}`);

  await runPm2([
    'start', script,
    '--name', pm2Name,
    '--no-autorestart',
    '--stop-exit-codes', '0',
    '--time',
    '--output', logOut,
    '--error', logErr,
    '--max-memory-restart', '1G'
  ], {
    AM_PLATINUM_HISTORICAL_REPORTS: reportId,
    AM_PLATINUM_HISTORICAL_DEALERS: dealers.join(','),
    AM_PLATINUM_HISTORICAL_START_DATE: '2021-01-01',
    AM_PLATINUM_HISTORICAL_HEADLESS: process.env.AM_PLATINUM_HISTORICAL_HEADLESS ?? 'false',
    AM_PLATINUM_HISTORICAL_FORCE_LOGIN: 'false',
    AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE: 'true',
    AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE: 'true',
    AM_PLATINUM_HISTORICAL_SKIP_EXISTING: 'false',
    AM_PLATINUM_HISTORICAL_STATE_FILE: runner === 'optimized-historical'
      ? `am-platinum-optimized-${slug}-state.json`
      : `am-platinum-historical-${slug}-state.json`,
    AM_PLATINUM_HISTORICAL_LOG_PREFIX: runner === 'optimized-historical'
      ? `am-platinum-optimized-${slug}`
      : `am-platinum-historical-${slug}`,
    LOG_SERVICE_NAME: pm2Name,
    NODE_ENV: 'production'
  });

  return { pm2Name, reportId, dealers, runner, action: 'started' };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AM Platinum Parallel Historical Launcher');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Parallel browsers are DISABLED — GDMS allows only one login/session.');
  console.log('  Use the sequential pipeline instead:');
  console.log('    npm run am-platinum:historical-pipeline');
  console.log('    pm2 start am-platinum-historical-pipeline');
  console.log('');
  process.exit(0);

  await stopSequentialPipeline();

  console.log('Analyzing per-dealer coverage to build launch queue...\n');
  const analysis = await analyzeAmPlatinumPerDealerCoverage({ writeQueue: true });
  const runs = analysis.historicalPending ?? analysis.groupedRuns ?? [];

  if (!runs.length) {
    console.log('✅ No historical reports need backfill.');
    return;
  }

  console.log(`\nLaunching ${runs.length} parallel browser job(s):\n`);

  const launched = [];

  for (const [index, run] of runs.entries()) {
    try {
      const result = await launchReport(run, index, runs.length);
      launched.push({ ...result, launchedAt: new Date().toISOString() });
    } catch (error) {
      console.error(`  Failed to launch ${run.reportId}: ${error.message}`);
      launched.push({
        reportId: run.reportId,
        runner: run.runner,
        dealers: run.dealers,
        action: 'failed',
        error: error.message,
        launchedAt: new Date().toISOString()
      });
    }

    if (index < runs.length - 1) {
      console.log(`  Waiting ${STAGGER_MS / 1000}s before next browser...\n`);
      await sleep(STAGGER_MS);
    }
  }

  await fs.mkdir(config.logsDir, { recursive: true });
  await fs.writeFile(LAUNCH_STATE_FILE, JSON.stringify({
    launchedAt: new Date().toISOString(),
    staggerMs: STAGGER_MS,
    operationWiseRunning: SKIP_OPERATION_WISE,
    runs,
    launched
  }, null, 2));

  try {
    await runPm2(['save']);
  } catch {
    // non-fatal
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  All parallel historical jobs launched');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Launch state: ${LAUNCH_STATE_FILE}`);
  console.log('  Monitor: pm2 list');
  console.log('  Logs:    pm2 logs am-plat-hist-<report-name>');
  console.log('\n  OTP logins are serialized via GDMS lock — approve OTP when each browser prompts.');
  console.log('  Operation-wise continues separately in am-platinum-operation-wise-historical.\n');
}

main().catch(error => {
  console.error('Parallel launcher failed:', error);
  process.exit(1);
});

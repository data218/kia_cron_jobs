import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { analyzeAmPlatinumPerDealerCoverage } from './analyze-am-platinum-per-dealer-coverage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const OPERATION_WISE_STATE = path.join(config.logsDir, 'am-platinum-operation-wise-recovery-state.json');
const PIPELINE_STATE = path.join(config.logsDir, 'am-platinum-historical-pipeline-state.json');
const QUEUE_FILE = path.join(config.logsDir, 'am-platinum-historical-queue.json');

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writePipelineState(payload) {
  await fs.mkdir(config.logsDir, { recursive: true });
  await fs.writeFile(
    PIPELINE_STATE,
    JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2)
  );
}

function operationWiseComplete(state) {
  if (!state) return false;
  if (state.status === 'success') return true;
  const dealerCount = state.dealerCodes?.length ?? 0;
  return dealerCount > 0 && (state.dealerIndex ?? 0) >= dealerCount;
}

function slugifyReportId(reportId) {
  return String(reportId).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function runPm2(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('pm2', args, {
      cwd: projectRoot,
      env: process.env,
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

/** Run one script to completion — only one browser/login at a time. */
function runNodeScript(scriptRelativePath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(projectRoot, scriptRelativePath);
    console.log(`\n▶ Running (single browser): node ${scriptRelativePath}`);
    if (extraEnv.AM_PLATINUM_HISTORICAL_REPORTS) {
      console.log(`  report: ${extraEnv.AM_PLATINUM_HISTORICAL_REPORTS}`);
    }
    if (extraEnv.AM_PLATINUM_HISTORICAL_DEALERS) {
      console.log(`  dealers: ${extraEnv.AM_PLATINUM_HISTORICAL_DEALERS}`);
    }

    const child = spawn(process.execPath, [scriptPath], {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
      shell: false
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scriptRelativePath} exited with code ${code}`));
      }
    });
  });
}

async function runOperationWiseIfNeeded() {
  const state = await readJson(OPERATION_WISE_STATE);
  if (operationWiseComplete(state)) {
    console.log('  Operation-wise backfill already complete — skipping.');
    await writePipelineState({ phase: 'operation_wise_complete', skipped: true });
    return;
  }

  const progress = state
    ? `dealer[${state.dealerIndex ?? 0}] type[${state.reportTypeIndex ?? 0}] month[${state.rangeIndex ?? 0}] last=${state.lastCompleted?.rangeStart ?? 'n/a'}`
    : 'not started';

  console.log(`\nPhase 1: Operation-wise historical backfill (${progress})`);
  console.log('  One browser only — will resume from saved state.\n');

  await writePipelineState({
    phase: 'running_operation_wise',
    operationWiseProgress: progress
  });

  await runNodeScript('scripts/recover-am-platinum-operation-wise.js', {
    AM_PLATINUM_HISTORICAL_HEADLESS: process.env.AM_PLATINUM_HISTORICAL_HEADLESS ?? 'false',
    LOG_SERVICE_NAME: 'am-platinum-historical-pipeline'
  });

  const finalState = await readJson(OPERATION_WISE_STATE);
  await writePipelineState({ phase: 'operation_wise_complete', operationWiseState: finalState });
  console.log('  Operation-wise backfill finished.');
}

async function loadExistingQueueAnalysis() {
  const existing = await readJson(QUEUE_FILE);
  if (!existing?.groupedRuns?.length) return null;

  console.log(`  Using existing queue from ${QUEUE_FILE} (${existing.groupedRuns.length} run(s)).`);
  return {
    ...existing,
    queue: existing.queue ?? [],
    groupedRuns: existing.groupedRuns
  };
}

async function buildHistoricalQueue() {
  console.log('\nPhase 2: Building PRIORITY-ONLY historical queue...');

  const PRIORITY_REPORTS = [
    'hyundai-repair-order-list',
    'hyundai-ro-billing-report',
    'hyundai-operation-wise-analysis-report'
  ];

  let analysis;
  try {
    const fullAnalysis = await analyzeAmPlatinumPerDealerCoverage({ writeQueue: false });
    const priorityRuns = fullAnalysis.groupedRuns.filter(run => 
      PRIORITY_REPORTS.includes(run.reportId)
    );

    console.log(`  Filtered to ${priorityRuns.length} priority report(s) out of ${fullAnalysis.groupedRuns.length} total`);
    priorityRuns.forEach(r => console.log(`    - ${r.reportId} → ${r.dealers.join(', ')} (${r.runner})`));

    analysis = {
      queue: fullAnalysis.queue.filter(q => PRIORITY_REPORTS.includes(q.reportId)),
      groupedRuns: priorityRuns
    };
  } catch (error) {
    console.warn(`  Coverage analysis failed: ${error.message}`);
    analysis = await loadExistingQueueAnalysis();
    if (!analysis) throw error;

    analysis.groupedRuns = analysis.groupedRuns.filter(run => 
      PRIORITY_REPORTS.includes(run.reportId)
    );
    analysis.queue = analysis.queue.filter(q => PRIORITY_REPORTS.includes(q.reportId));
  }

  await writePipelineState({
    phase: 'queue_built',
    queueSize: analysis.queue?.length ?? 0,
    groupedRuns: analysis.groupedRuns,
    mode: 'priority-only'
  });
  return analysis;
}

async function runQueuedHistoricalBackfills(groupedRuns) {
  if (!groupedRuns.length) {
    console.log('\nPhase 3: No additional historical backfills needed.');
    return;
  }

  console.log(`\nPhase 3: Running ${groupedRuns.length} queued report(s) one at a time...`);
  await writePipelineState({ phase: 'running_missing_historical', groupedRuns, currentIndex: 0 });

  for (const [index, run] of groupedRuns.entries()) {
    const slug = slugifyReportId(run.reportId);
    console.log(`\n── Queue [${index + 1}/${groupedRuns.length}]: ${run.reportId} (${run.runner})`);
    console.log(`   dealers: ${run.dealers.join(', ')}`);

    await writePipelineState({
      phase: 'running_missing_historical',
      currentIndex: index,
      currentReport: run.reportId,
      groupedRuns
    });

    const commonEnv = {
      AM_PLATINUM_HISTORICAL_REPORTS: run.reportId,
      AM_PLATINUM_HISTORICAL_DEALERS: run.dealers.join(','),
      AM_PLATINUM_HISTORICAL_HEADLESS: process.env.AM_PLATINUM_HISTORICAL_HEADLESS ?? 'false',
      AM_PLATINUM_HISTORICAL_FORCE_LOGIN: 'false',
      LOG_SERVICE_NAME: 'am-platinum-historical-pipeline'
    };

    try {
      if (run.runner === 'optimized-historical') {
        await runNodeScript('scripts/run-am-platinum-optimized-backfill.js', {
          ...commonEnv,
          AM_PLATINUM_HISTORICAL_STATE_FILE: `am-platinum-optimized-${slug}-state.json`,
          AM_PLATINUM_HISTORICAL_LOG_PREFIX: `am-platinum-optimized-${slug}`
        });
      } else {
        await runNodeScript('scripts/run-am-platinum-historical-backfill.js', {
          ...commonEnv,
          AM_PLATINUM_HISTORICAL_START_DATE: '2021-01-01',
          AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE: 'true',
          AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE: 'true',
          AM_PLATINUM_HISTORICAL_SKIP_EXISTING: 'false',
          AM_PLATINUM_HISTORICAL_STATE_FILE: `am-platinum-historical-${slug}-state.json`,
          AM_PLATINUM_HISTORICAL_LOG_PREFIX: `am-platinum-historical-${slug}`
        });
      }
      console.log(`   ✅ Completed: ${run.reportId}`);
    } catch (error) {
      console.error(`   ❌ Failed: ${run.reportId} — ${error.message}`);
      console.error('   Continuing with next queued report...');
      await writePipelineState({
        phase: 'running_missing_historical',
        currentIndex: index,
        currentReport: run.reportId,
        lastError: error.message
      });
    }
  }
}

async function startPlatinumCron() {
  await writePipelineState({ phase: 'starting_platinum_cron' });

  try {
    console.log('\nPhase 4: Starting am-platinum-cron-job...');
    await runPm2(['start', 'am-platinum-cron-job']);
    await runPm2(['save']);
  } catch (error) {
    if (/already exists|online/i.test(error.message)) {
      console.log('  am-platinum-cron-job already running.');
    } else {
      console.warn(`  Could not start am-platinum-cron-job: ${error.message}`);
    }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AM Platinum Sequential Historical Pipeline');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ONE browser / ONE login at a time (GDMS session limit).');
  console.log('  Each job runs to completion before the next starts.');
  console.log(`  Queue file: ${QUEUE_FILE}\n`);

  await writePipelineState({
    phase: 'started',
    mode: 'sequential-single-browser',
    startedAt: new Date().toISOString()
  });

  await runOperationWiseIfNeeded();

  const initialAnalysis = await buildHistoricalQueue();
  await runQueuedHistoricalBackfills(initialAnalysis.groupedRuns);

  const PRIORITY_REPORTS = [
    'hyundai-repair-order-list',
    'hyundai-ro-billing-report',
    'hyundai-operation-wise-analysis-report'
  ];

  const finalAnalysis = await analyzeAmPlatinumPerDealerCoverage({ writeQueue: true });
  const priorityQueue = finalAnalysis.queue.filter(q => PRIORITY_REPORTS.includes(q.reportId));
  if (priorityQueue.length > 0) {
    console.warn(`\n⚠️  ${priorityQueue.length} PRIORITY dealer/report pair(s) still missing:`);
    priorityQueue.forEach(q => console.warn(`    - ${q.dealer} | ${q.reportId} | ${q.reason}`));
  } else {
    console.log('\n✅ All priority historical reports have data from Jan 2021');
  }
  console.log(`  (Other reports: ${finalAnalysis.queue.length - priorityQueue.length} gaps — will get current month only via cron)`);

  await startPlatinumCron();

  await writePipelineState({
    phase: 'complete',
    status: finalAnalysis.queue.length === 0 ? 'success' : 'partial',
    remainingQueueSize: finalAnalysis.queue.length,
    completedAt: new Date().toISOString()
  });

  console.log('\n✅ Sequential pipeline complete.');
}

main().catch(async error => {
  console.error('\n❌ Pipeline failed:', error.message);
  await writePipelineState({
    phase: 'failed',
    status: 'failed',
    error: error.message
  }).catch(() => {});
  process.exit(1);
});

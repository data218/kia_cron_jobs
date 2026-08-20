// Runs the Hyundai backfills back-to-back in one command:
//   1. Sales Report   — all dealers, one at a time
//   2. Enquiry Report — all dealers, one at a time
//
// Sequential on purpose. Both drive the same MIS5216 login, and the active dealer is
// server-side session state, so running them concurrently would let one script switch the
// dealer out from under the other — silently exporting one dealer's rows under another's
// code. See the header of run-hyundai-sales-historical-all-dealers.js.
//
// Stage 2 starts even if stage 1 reports failed chunks, because a partial sales run should
// not block the enquiry backfill. Nothing is skipped silently — the summary at the end
// reports each stage's exit code.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

function flag(name, fallback) {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const passthrough = [];
if (process.argv.includes('--headless')) passthrough.push('--headless');
const dealers = flag('dealers', null);
if (dealers) passthrough.push(`--dealers=${dealers}`);

// --skip=sales (or --only=enquiry) leaves a finished stage alone instead of walking its
// whole range again just to skip every chunk.
const SKIP = (flag('skip', '') || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
const ONLY = (flag('only', '') || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

const ALL_STAGES = [
  {
    key: 'sales',
    name: 'Hyundai Sales Report',
    script: 'run-hyundai-sales-historical-all-dealers.js',
    args: [`--start=${flag('sales-start', '2020-01-01')}`, ...(flag('sales-end', null) ? [`--end=${flag('sales-end')}`] : [])]
  },
  {
    key: 'enquiry',
    name: 'Hyundai Enquiry Report',
    script: 'run-hyundai-enquiry-historical-2006-to-today.js',
    // No default --end: the enquiry backfill runs through to TODAY, not 2020.
    args: [
      `--start=${flag('enquiry-start', '2006-01-01')}`,
      ...(flag('enquiry-end', null) ? [`--end=${flag('enquiry-end')}`] : [])
    ]
  }
];

const STAGES = ALL_STAGES.filter(stage => {
  if (ONLY.length) return ONLY.includes(stage.key);
  return !SKIP.includes(stage.key);
});

if (!STAGES.length) {
  console.error('No stages selected. Use --only=sales|enquiry or --skip=sales|enquiry.');
  process.exit(1);
}
console.log('Stages to run: ' + STAGES.map(s => s.key).join(' -> '));

function run(stage) {
  const args = [path.join(scriptsDir, stage.script), ...stage.args, ...passthrough];
  console.log(`\n=========== STAGE: ${stage.name} ===========`);
  console.log(`node ${args.join(' ')}\n`);

  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', code => resolve(code ?? 1));
    child.on('error', error => {
      console.error(`Failed to start ${stage.name}: ${error.message}`);
      resolve(1);
    });
  });
}

const results = [];
for (const stage of STAGES) {
  const code = await run(stage);
  results.push({ stage: stage.name, exitCode: code, status: code === 0 ? 'completed' : 'completed with errors' });
}

console.log('\n=========== CHAIN SUMMARY ===========');
for (const result of results) {
  console.log(`  ${result.stage}: ${result.status} (exit ${result.exitCode})`);
}

process.exitCode = results.every(result => result.exitCode === 0) ? 0 : 1;

/**
 * resume-am-platinum-mis1988.js
 *
 * One-shot resume script: runs AM Platinum Phase 2 ONLY.
 * Logs in as MIS1988 and pulls all configured reports for dealer N6250.
 *
 * Use this when the full daily run was interrupted after Phase 1
 * (MIS12345 / N5211 + N6828) but before Phase 2 (MIS1988 / N6250) ran.
 *
 * Usage:
 *   node --env-file=.env scripts/resume-am-platinum-mis1988.js
 *
 * The daily PM2 job (am-platinum-cron-job) will continue to run BOTH
 * phases automatically at scheduled times — this script is for manual catch-up only.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schedulerPath = path.join(__dirname, '..', 'src', 'cron', 'am-platinum-scheduler.js');

console.log('='.repeat(60));
console.log('AM Platinum RESUME — Phase 2 only (MIS1988 → N6250)');
console.log('Started at:', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 'IST');
console.log('Command: node --env-file=.env', schedulerPath, '--phase2-only');
console.log('='.repeat(60));

// Inherit env + .env file; pass --phase2-only so Phase 1 is skipped
const child = spawn(
  'node',
  ['--env-file=.env', schedulerPath, '--phase2-only'],
  {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env }
  }
);

child.on('exit', (code) => {
  console.log('='.repeat(60));
  console.log('Finished at:', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 'IST');
  console.log('Exit code:', code);
  console.log('='.repeat(60));
  process.exit(code ?? 0);
});

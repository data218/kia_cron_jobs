// Master runner for all AM Platinum reports
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const JOBS = [
  {
    name: '1. AM Platinum GDMS Core Reports (RO Billing, Repair Orders, PSF, Lubricants, etc.)',
    cmd: 'node',
    args: ['./src/cron/am-platinum-scheduler.js', '--once']
  },
  {
    name: '2. AM Platinum Booking Report',
    cmd: 'node',
    args: ['./scripts/run-hyundai-booking-report.js', '--accounts=am-platinum', '--headless']
  },
  {
    name: '3. AM Platinum Enquiry Report (Last 30 Days)',
    cmd: 'node',
    args: ['./scripts/run-platinum-enquiry-report.js', '--days=30', '--headless']
  },
  {
    name: '4. AM Platinum Purchase Report (Last 30 Days)',
    cmd: 'node',
    args: ['./scripts/run-platinum-purchase-report.js', '--days=30', '--headless']
  },
  {
    name: '5. AM Platinum Sales Report (Last 30 Days)',
    cmd: 'node',
    args: ['./scripts/run-platinum-sales-report.js', '--days=30', '--headless']
  }
];

function runCommand(cmd, args, jobName) {
  return new Promise((resolve) => {
    console.log(`\n============================================================`);
    console.log(`▶️ STARTING: ${jobName}`);
    console.log(`   Command: ${cmd} ${args.join(' ')}`);
    console.log(`   Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    console.log(`============================================================\n`);

    const proc = spawn(cmd, args, {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, NODE_ENV: 'production' }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`\n✅ COMPLETED: ${jobName} (Exit code: 0)\n`);
      } else {
        console.error(`\n⚠️ FAILED / WARNING: ${jobName} (Exit code: ${code})\n`);
      }
      resolve({ jobName, code });
    });

    proc.on('error', (err) => {
      console.error(`\n❌ ERROR spawning ${jobName}:`, err.message);
      resolve({ jobName, code: 1, error: err.message });
    });
  });
}

async function main() {
  console.log(`🚀 STARTING ALL AM PLATINUM REPORTS EXECUTION`);
  console.log(`Total jobs queued: ${JOBS.length}\n`);

  const results = [];
  for (const job of JOBS) {
    const res = await runCommand(job.cmd, job.args, job.name);
    results.push(res);
  }

  console.log(`\n============================================================`);
  console.log(`🎉 ALL AM PLATINUM JOBS FINISHED`);
  console.log(`============================================================\n`);
  console.table(results);
}

main().catch(console.error);

/**
 * PRANK SCRIPT — FAKE SECURITY BREACH SIMULATION
 * ------------------------------------------------
 * Nothing real happens here. This is 100% fake output.
 * No services are stopped. No data is deleted. No keys are rotated.
 * Pure cosmetic terminal output for educational purposes.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN  = '\x1b[32m';
const CYAN   = '\x1b[36m';
const WHITE  = '\x1b[37m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const RESET  = '\x1b[0m';

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function log(level, msg, color = WHITE) {
  console.log(`${DIM}[${ts()}]${RESET} ${color}${BOLD}[${level}]${RESET} ${color}${msg}${RESET}`);
}

function info(msg)  { log('INFO ', msg, CYAN);   }
function warn(msg)  { log('WARN ', msg, YELLOW); }
function error(msg) { log('ERROR', msg, RED);    }
function fatal(msg) { log('FATAL', msg, `${RED}${BOLD}`); }
function ok(msg)    { log('OK   ', msg, GREEN);  }

async function run() {

  console.clear();

  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║         PRODUCTION SYSTEM MONITOR — LIVE LOG STREAM             ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝${RESET}\n`);

  await sleep(600);

  info('System health check initiated...');
  await sleep(400);
  info('Connecting to production cluster [prod-k8s-ap-south-1]...');
  await sleep(700);
  ok('Cluster connection established (3 nodes healthy)');
  await sleep(300);
  info('Loading environment configuration from Vault...');
  await sleep(900);
  ok('ENV loaded: DATABASE_URL, SUPABASE_KEY, GITHUB_TOKEN, SMTP_PASSWORD ✓');
  await sleep(500);
  info('Starting routine log rotation & audit trail scan...');
  await sleep(1200);

  console.log();

  // ── First anomaly ──
  warn('Anomaly detector triggered — unusual auth pattern detected on API gateway');
  await sleep(800);
  warn('GeoIP mismatch: 3 concurrent sessions from RU/CN/NG on service account [sa-prod-deploy]');
  await sleep(600);
  warn('Rate limiter tripped: 2,847 requests in 4s from 185.220.101.x (Tor exit node)');
  await sleep(500);

  console.log();

  error('GITHUB WEBHOOK ALERT — Repository event: push to main by unknown actor');
  await sleep(400);
  error('Actor: gh-actions-bot[compromised]  |  IP: 185.220.101.47  |  Time: ' + ts());
  await sleep(600);
  error('.env file committed to public branch: kia_cron_jobs/.env');
  await sleep(400);
  error('Secrets detected in commit a3f91cc:');
  await sleep(300);
  console.log(`         ${RED}  SUPABASE_URL       = https://xxxxxxxxxxxxxxxx.supabase.co${RESET}`);
  await sleep(200);
  console.log(`         ${RED}  SUPABASE_ANON_KEY  = eyJhbGciOiJIUzI1NiIsInR5cCI6...${RESET}`);
  await sleep(200);
  console.log(`         ${RED}  DATABASE_URL       = postgresql://postgres:[REDACTED]@db...${RESET}`);
  await sleep(200);
  console.log(`         ${RED}  AM_PLATINUM_PASSWORD = [REDACTED]${RESET}`);
  await sleep(200);
  console.log(`         ${RED}  GITHUB_TOKEN       = ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx${RESET}`);
  await sleep(700);

  console.log();

  error('SECRET SCANNER (GitGuardian): 5 high-severity secrets exposed in public history');
  await sleep(500);
  error('Supabase auto-detected leaked anon key — JWT invalidation in progress...');
  await sleep(800);
  error('GitHub has suspended repository write access pending security review');
  await sleep(600);

  console.log();

  // ── Database breach ──
  fatal('DATABASE BREACH DETECTED — Supabase row-level security bypass via leaked service key');
  await sleep(500);
  fatal('Unauthorized SELECT * on tables: am_platinum_repair_order_list, hyundai_operation_wise_analysis_report');
  await sleep(600);
  fatal('Unauthorized DELETE executed — 14,882 rows affected across 6 tables');
  await sleep(800);
  fatal('Attacker IP: 185.220.101.47 | Query time: ' + ts());
  await sleep(400);
  fatal('Connection pool exhausted (50/50 connections held by malicious actor)');
  await sleep(700);

  console.log();

  // ── Services going down ──
  error('Circuit breaker OPEN — all outbound DB calls suspended');
  await sleep(500);
  error('pm2: am-platinum-cron-job → STOPPING (exit code 137 — SIGKILL from OOM killer)');
  await sleep(300);
  error('pm2: hmil-cron-job         → STOPPING');
  await sleep(300);
  error('pm2: kia-cron-scheduler    → STOPPING');
  await sleep(300);
  error('pm2: kia-otp-webhook       → STOPPING (port 3001 unresponsive)');
  await sleep(300);
  error('pm2: kia-rsa-cron-job      → STOPPING');
  await sleep(400);
  warn('Dashboard API returning 503 Service Unavailable — health endpoint unreachable');
  await sleep(500);
  error('Webhook server offline — OTP flow broken for all active sessions');
  await sleep(600);

  console.log();

  // ── Billing/cost alert ──
  warn('AWS Cost Anomaly: $3,240 spend spike in last 2 hours (normal: ~$12/day)');
  await sleep(400);
  warn('Suspected crypto-mining workload detected on EC2 t3.micro (CPU 100%)');
  await sleep(700);

  console.log();

  // ── Incident declared ──
  console.log(`${RED}${BOLD}╔══════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${RED}${BOLD}║  🚨  CRITICAL INCIDENT DECLARED — SEV-1 — ALL SERVICES DOWN  🚨  ║${RESET}`);
  console.log(`${RED}${BOLD}╚══════════════════════════════════════════════════════════════════╝${RESET}`);

  await sleep(800);
  console.log();

  error('Incident ID: INC-2026-0624-001');
  error('Severity: SEV-1 (Complete Service Outage + Data Breach)');
  error('Affected: ALL production services, dashboard, OTP flow, cron jobs');
  error('Root Cause: .env file + GitHub token committed to public repository');
  await sleep(500);

  console.log();

  warn('ACTION REQUIRED — Rotate the following credentials IMMEDIATELY:');
  await sleep(300);
  console.log(`         ${YELLOW}  1. Supabase service key & anon key (Dashboard → Settings → API)${RESET}`);
  await sleep(200);
  console.log(`         ${YELLOW}  2. GitHub Personal Access Token (Settings → Developer → Tokens)${RESET}`);
  await sleep(200);
  console.log(`         ${YELLOW}  3. PostgreSQL database password (Supabase → Database → Password)${RESET}`);
  await sleep(200);
  console.log(`         ${YELLOW}  4. All third-party API keys in .env${RESET}`);
  await sleep(200);
  console.log(`         ${YELLOW}  5. Revoke all active OAuth sessions${RESET}`);
  await sleep(800);

  console.log();

  fatal('Estimated data exposure: 14,882 rows (customer VINs, mobile numbers, RO data)');
  fatal('Regulatory notification may be required under DPDP Act 2023 within 72 hours');
  await sleep(600);

  console.log();

  info('Incident response team paged: oncall-prod@company.internal');
  info('War room opened: https://meet.google.com/xxx-xxxx-xxx');
  info('Status page updated: https://status.example.com → Major Outage');
  await sleep(800);

  console.log();

  // ── The reveal ──
  console.log(`\n${YELLOW}${BOLD}${'─'.repeat(68)}${RESET}`);
  console.log(`${YELLOW}${BOLD}  WAIT. Take a breath.${RESET}`);
  console.log(`${YELLOW}${BOLD}${'─'.repeat(68)}${RESET}\n`);
  await sleep(1000);

  console.log(`${GREEN}${BOLD}  THIS WAS A SIMULATION. Nothing above was real.${RESET}`);
  await sleep(600);
  console.log(`${GREEN}  No data was deleted. No keys were leaked. No services are down.${RESET}`);
  await sleep(600);
  console.log(`${GREEN}  Your database is fine. GitHub is fine. Everything is fine.${RESET}\n`);
  await sleep(800);

  console.log(`${RED}${BOLD}  BUT — if you had committed your .env to GitHub, ALL of the above${RESET}`);
  console.log(`${RED}${BOLD}  could have happened within MINUTES. Bots scan GitHub 24/7.${RESET}\n`);
  await sleep(800);

  console.log(`${YELLOW}${BOLD}  RULES you must never break:${RESET}`);
  await sleep(300);
  console.log(`${WHITE}    ✗  NEVER commit .env files to any repository (public or private)${RESET}`);
  await sleep(200);
  console.log(`${WHITE}    ✗  NEVER give AI tools full GitHub write access${RESET}`);
  await sleep(200);
  console.log(`${WHITE}    ✗  NEVER paste API keys in chat, Discord, or Slack${RESET}`);
  await sleep(200);
  console.log(`${WHITE}    ✗  NEVER use the same key across dev + production${RESET}`);
  await sleep(200);
  console.log(`${WHITE}    ✓  Always add .env to .gitignore BEFORE your first commit${RESET}`);
  await sleep(200);
  console.log(`${WHITE}    ✓  Use GitHub Secrets / Vault for CI/CD credentials${RESET}`);
  await sleep(200);
  console.log(`${WHITE}    ✓  Rotate keys regularly even if nothing went wrong${RESET}`);
  await sleep(400);

  console.log(`\n${DIM}  (Lesson delivered. You're welcome.)${RESET}\n`);
}

run().catch(console.error);

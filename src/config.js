import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

function envDelayMs(name, fallback, max = 5000) {
  return Math.min(envInt(name, fallback), max);
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

export const config = {
  rootDir,
  loginUrl: env('KIA_DMS_URL', 'https://dms.kiaindia.net/cmm/cmmi/selectLoginMain.dms'),
  userId: env('KIA_USER_ID', env('KIA_DMS_USER_ID', 'EJK4020041')),
  password: env('KIA_PASSWORD', env('KIA_DMS_PASSWORD')),
  otpProvider: env('OTP_PROVIDER', 'telegram'),
  telegramBotToken: env('TELEGRAM_BOT_TOKEN'),
  telegramChatId: env('TELEGRAM_CHAT_ID'),
  telegramPollIntervalMs: envInt('TELEGRAM_POLL_INTERVAL_MS', 3000),
  telegramDropOldUpdates: envBool('TELEGRAM_DROP_OLD_UPDATES', true),
  otpRegex: new RegExp(env('OTP_REGEX', '\\d{4,6}')),
  otpFilePath: path.resolve(rootDir, env('OTP_FILE_PATH', './otp-inbox.json')),
  otpWebhookBaseUrl: env('OTP_WEBHOOK_BASE_URL', 'http://127.0.0.1:3333'),
  otpWebhookToken: env('OTP_WEBHOOK_TOKEN', 'change-me'),
  otpWebhookHost: env('OTP_WEBHOOK_HOST', '0.0.0.0'),
  otpWebhookPort: envInt('OTP_WEBHOOK_PORT', envInt('PORT', 3333)),
  otpWebhookDebug: envBool('OTP_WEBHOOK_DEBUG', false),
  cronSchedule: env('CRON_SCHEDULE', '0 8 * * *'),
  headless: envBool('HEADLESS', false),
  slowMoMs: envInt('SLOW_MO_MS', 0),
  pageReadyDelayMs: envDelayMs('PAGE_READY_DELAY_MS', 5000),
  otpTimeoutMs: envInt('OTP_TIMEOUT_MS', 180000),
  loginTimeoutMs: envInt('LOGIN_TIMEOUT_MS', 60000),
  loginRetries: envInt('LOGIN_RETRIES', 2),
  retryDelayMs: envInt('RETRY_DELAY_MS', 15000),
  sessionStatePath: path.resolve(rootDir, env('SESSION_STATE_PATH', './storage/kia-dms-state.json')),
  downloadDir: path.resolve(rootDir, env('DOWNLOAD_DIR', './downloads')),
  reportChunksDir: path.resolve(rootDir, env('REPORT_CHUNKS_DIR', './downloads/report-chunks')),
  reportDateFormat: env('REPORT_DATE_FORMAT', 'DD/MM/YYYY'),
  reportsToRun: env('REPORTS_TO_RUN', 'rsa-report'),
  roBillingPageSize: env('RO_BILLING_PAGE_SIZE', '300'),
  roBillingPostSearchDelayMs: envDelayMs('RO_BILLING_POST_SEARCH_DELAY_MS', 5000),
  supabaseUrl: env('SUPABASE_URL'),
  supabaseServiceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseAnonKey: env('SUPABASE_ANON_KEY', env('NEXT_PUBLIC_SUPABASE_ANON_KEY')),
  supabaseReportsTable: env('SUPABASE_REPORTS_TABLE', 'business_excellence_am_kia_new'),
  roBillingSheetName: env('RO_BILLING_SHEET_NAME', 'RO Billing Report March 25'),
  kiaCallCenterComplaintsSheetName: env('KIA_CALL_CENTER_COMPLAINTS_SHEET_NAME', 'Kia call center complaints'),
  kiaCallCenterComplaintsPageSize: env('KIA_CALL_CENTER_COMPLAINTS_PAGE_SIZE', '300'),
  kiaCallCenterComplaintsPostSearchDelayMs: envDelayMs('KIA_CALL_CENTER_COMPLAINTS_POST_SEARCH_DELAY_MS', 5000),
  openRoYearlySheetName: env('OPEN_RO_YEARLY_SHEET_NAME', 'Open RO Yearly'),
  openRoYearlyPageSize: env('OPEN_RO_YEARLY_PAGE_SIZE', '300'),
  openRoYearlyStartDate: env('OPEN_RO_YEARLY_START_DATE', '2025-03-01'),
  openRoYearlyPostSearchDelayMs: envDelayMs('OPEN_RO_YEARLY_POST_SEARCH_DELAY_MS', 5000),
  openRoYearlyBetweenChunksDelayMs: envDelayMs('OPEN_RO_YEARLY_BETWEEN_CHUNKS_DELAY_MS', 4000),
  psfYearlySheetName: env('PSF_YEARLY_SHEET_NAME', 'PSF Yearly'),
  psfYearlyPageSize: env('PSF_YEARLY_PAGE_SIZE', '300'),
  psfYearlyPostSearchDelayMs: envDelayMs('PSF_YEARLY_POST_SEARCH_DELAY_MS', 5000),
  psfYearlyBetweenChunksDelayMs: envDelayMs('PSF_YEARLY_BETWEEN_CHUNKS_DELAY_MS', 4000),
  ewReportSheetName: env('EW_REPORT_SHEET_NAME', 'EW Report'),
  ewReportPageSize: env('EW_REPORT_PAGE_SIZE', '300'),
  ewReportPostSearchDelayMs: envDelayMs('EW_REPORT_POST_SEARCH_DELAY_MS', 5000),
  mcpReportSheetName: env('MCP_REPORT_SHEET_NAME', 'MCP Report'),
  mcpReportPageSize: env('MCP_REPORT_PAGE_SIZE', '300'),
  mcpReportPostSearchDelayMs: envDelayMs('MCP_REPORT_POST_SEARCH_DELAY_MS', 5000),
  rsaPortalUrl: env('RSA_PORTAL_URL', 'https://kia.awpassistance.in/report'),
  rsaReportUrl: env('RSA_REPORT_URL', 'https://kia.awpassistance.in/report'),
  rsaUserId: env('RSA_USER_ID'),
  rsaPassword: env('RSA_PASSWORD'),
  rsaSessionStatePath: path.resolve(rootDir, env('RSA_SESSION_STATE_PATH', './storage/rsa-portal-state.json')),
  rsaReportSheetName: env('RSA_REPORT_SHEET_NAME', 'RSA Report'),
  rsaReportPostSearchDelayMs: envDelayMs('RSA_REPORT_POST_SEARCH_DELAY_MS', 5000),
  rsaReportPageLoadDelayMs: envDelayMs('RSA_REPORT_PAGE_LOAD_DELAY_MS', 5000),
  rsaHumanDelayMinMs: envInt('RSA_HUMAN_DELAY_MIN_MS', 1200),
  rsaHumanDelayMaxMs: envDelayMs('RSA_HUMAN_DELAY_MAX_MS', 2800),
  rsaTypingDelayMs: envInt('RSA_TYPING_DELAY_MS', 90),
  rsaCaptchaTimeoutMs: envInt('RSA_CAPTCHA_TIMEOUT_MS', 600000),
  rsaCdpEndpoint: env('RSA_CDP_ENDPOINT'),
  rsaUsePersistentProfile: envBool('RSA_USE_PERSISTENT_PROFILE', false),
  rsaUserDataDir: path.resolve(rootDir, env('RSA_USER_DATA_DIR', './storage/rsa-chrome-profile'))
};

export function requireSecret(name, value) {
  if (!value) {
    throw new Error(`${name} is required. Add it to .env before running the automation.`);
  }
}

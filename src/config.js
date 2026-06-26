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

function envList(name, fallback = '') {
  return env(name, fallback)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

export const config = {
  rootDir,
  loginUrl: env('KIA_DMS_URL', 'https://dms.kiaindia.net/cmm/cmmi/selectLoginMain.dms'),
  userId: env('KIA_USER_ID', env('KIA_DMS_USER_ID', 'EJK4020041')),
  password: env('KIA_PASSWORD', env('KIA_DMS_PASSWORD')),
  otpProvider: env('OTP_PROVIDER', 'manual'),
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
  otpFreshnessGraceMs: envInt('OTP_FRESHNESS_GRACE_MS', 15000),
  cronSchedule: env('CRON_SCHEDULE', '0 9-18 * * *'),
  regularReportsCronSchedule: env('REGULAR_REPORTS_CRON_SCHEDULE', env('CRON_SCHEDULE', '0 9-18 * * *')),
  rsaReportCronSchedule: env('RSA_REPORT_CRON_SCHEDULE', '5 10 * * *'),
  openRoYearlyCronSchedule: env('OPEN_RO_YEARLY_CRON_SCHEDULE', '10 18 * * *'),
  kiaCallCenterComplaintsCronSchedule: env('KIA_CALL_CENTER_COMPLAINTS_CRON_SCHEDULE', '25 18 * * *'),
  demoJobCardsCronSchedule: env('DEMO_JOB_CARDS_CRON_SCHEDULE', '30 10,18 * * *'),
  demoCarListCronSchedule: env('DEMO_CAR_LIST_CRON_SCHEDULE', '30 15 * * 1'),
  serviceAppointmentCronSchedule: env('SERVICE_APPOINTMENT_CRON_SCHEDULE', '45 18 * * *'),
  roBillingCronSchedule: env('RO_BILLING_CRON_SCHEDULE', '0 9-18 * * *'),
  hmilRepairOrderCronSchedule: env('HMIL_REPAIR_ORDER_CRON_SCHEDULE', '20 10-18 * * *'),
  headless: envBool('HEADLESS', false),
  slowMoMs: envInt('SLOW_MO_MS', 0),
  pageReadyDelayMs: envDelayMs('PAGE_READY_DELAY_MS', 5000),
  otpTimeoutMs: envInt('OTP_TIMEOUT_MS', 180000),
  loginTimeoutMs: envInt('LOGIN_TIMEOUT_MS', 60000),
  loginRetries: envInt('LOGIN_RETRIES', 2),
  kiaForceLogin: envBool('KIA_FORCE_LOGIN', false),
  retryDelayMs: envInt('RETRY_DELAY_MS', 15000),
  playwrightActionTimeoutMs: envInt('PLAYWRIGHT_ACTION_TIMEOUT_MS', 45000),
  playwrightNavigationTimeoutMs: envInt('PLAYWRIGHT_NAVIGATION_TIMEOUT_MS', 60000),
  networkCheckUrl: env('NETWORK_CHECK_URL', 'https://www.gstatic.com/generate_204'),
  networkCheckUrls: envList(
    'NETWORK_CHECK_URLS',
    'https://www.gstatic.com/generate_204,https://dms.kiaindia.net/'
  ),
  networkCheckTimeoutMs: envInt('NETWORK_CHECK_TIMEOUT_MS', 8000),
  networkWaitTimeoutMs: envInt('NETWORK_WAIT_TIMEOUT_MS', 1800000),
  networkStartupWaitTimeoutMs: envInt('NETWORK_STARTUP_WAIT_TIMEOUT_MS', 60000),
  networkStartupFailOpen: envBool('NETWORK_STARTUP_FAIL_OPEN', true),
  networkStartupRetryDelayMs: envInt('NETWORK_STARTUP_RETRY_DELAY_MS', 900000),
  networkRetryIntervalMs: envInt('NETWORK_RETRY_INTERVAL_MS', 15000),
  reportMaxRetries: envInt('REPORT_MAX_RETRIES', 3),
  reportRetryDelayMinMs: envInt('REPORT_RETRY_DELAY_MIN_MS', 30000),
  reportRetryDelayMaxMs: envInt('REPORT_RETRY_DELAY_MAX_MS', 60000),
  sessionStatePath: path.resolve(rootDir, env('SESSION_STATE_PATH', './storage/kia-dms-state.json')),
  downloadDir: path.resolve(rootDir, env('DOWNLOAD_DIR', './downloads')),
  reportChunksDir: path.resolve(rootDir, env('REPORT_CHUNKS_DIR', './downloads/report-chunks')),
  tempDir: path.resolve(rootDir, env('TEMP_DIR', './temp')),
  mergedDir: path.resolve(rootDir, env('MERGED_DIR', './downloads/merged')),
  logsDir: path.resolve(rootDir, env('LOGS_DIR', './logs')),
  screenshotsDir: path.resolve(rootDir, env('SCREENSHOTS_DIR', './logs/screenshots')),
  reportDateFormat: env('REPORT_DATE_FORMAT', 'DD/MM/YYYY'),
  reportsToRun: env('REPORTS_TO_RUN', 'all'),
  testSingleReport: envBool('TEST_SINGLE_REPORT', false),
  testReportName: env('TEST_REPORT_NAME'),
  primaryDealerCode: env('PRIMARY_DEALER_CODE', 'JK402').trim().toUpperCase(),
  forceActiveDealerCode: env('FORCE_ACTIVE_DEALER_CODE', '').trim().toUpperCase(),
  multiDealerEnabled: envBool('MULTI_DEALER_ENABLED', false),
  multiDealerExecutionStrategy: env('MULTI_DEALER_EXECUTION_STRATEGY', 'report-first').trim().toLowerCase(),
  additionalDealerCodes: env('ADDITIONAL_DEALER_CODES', '')
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean),
  primaryDealerOnlyModes: env('PRIMARY_DEALER_ONLY_MODES', 'demo-car-list')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  dealerChangeTimeoutMs: envInt('DEALER_CHANGE_TIMEOUT_MS', 90000),
  dryRunReports: envBool('DRY_RUN_REPORTS', false),
  dryRunReportDelayMs: envInt('DRY_RUN_REPORT_DELAY_MS', 500),
  skipRegularRunWhenSchedulerBusy: envBool('SKIP_REGULAR_RUN_WHEN_SCHEDULER_BUSY', false),
  kiaCronTimezone: env('KIA_CRON_TIMEZONE', 'Asia/Kolkata'),
  historicalBackfillEnabled: envBool('HISTORICAL_BACKFILL_ENABLED', false),
  historicalBackfillStartDate: env('HISTORICAL_BACKFILL_START_DATE', '2025-01-01'),
  reportDateOverrideStartDate: env('REPORT_DATE_OVERRIDE_START_DATE'),
  reportDateOverrideEndDate: env('REPORT_DATE_OVERRIDE_END_DATE'),
  alertEmailFrom: env('ALERT_EMAIL_FROM'),
  alertEmailTo: env('ALERT_EMAIL_TO'),
  alertEmailAppPassword: env('ALERT_EMAIL_APP_PASSWORD'),
  roBillingPageSize: env('RO_BILLING_PAGE_SIZE', '300'),
  roBillingPostSearchDelayMs: envDelayMs('RO_BILLING_POST_SEARCH_DELAY_MS', 5000),
  supabaseUrl: env('SUPABASE_URL'),
  supabaseServiceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseAnonKey: env('SUPABASE_ANON_KEY', env('NEXT_PUBLIC_SUPABASE_ANON_KEY')),
  supabaseReportsTable: env('SUPABASE_REPORTS_TABLE', 'business_excellence_am_kia_new'),
  supabaseJsonBackupEnabled: envBool('SUPABASE_JSON_BACKUP_ENABLED', false),
  databaseUrl: env('DATABASE_URL'),
  roBillingSheetName: env('RO_BILLING_SHEET_NAME', 'RO Billing Report'),
  roBillingBackfillEnabled: envBool('RO_BILLING_BACKFILL_ENABLED', false),
  roBillingBackfillStartDate: env('RO_BILLING_BACKFILL_START_DATE', '2025-03-01'),
  roBillingBetweenChunksDelayMs: envDelayMs('RO_BILLING_BETWEEN_CHUNKS_DELAY_MS', 4000),
  kiaCallCenterComplaintsSheetName: env('KIA_CALL_CENTER_COMPLAINTS_SHEET_NAME', 'Kia call center complaints'),
  kiaCallCenterComplaintsPageSize: env('KIA_CALL_CENTER_COMPLAINTS_PAGE_SIZE', '300'),
  kiaCallCenterComplaintsPostSearchDelayMs: envDelayMs('KIA_CALL_CENTER_COMPLAINTS_POST_SEARCH_DELAY_MS', 5000),
  kiaCallCenterComplaintsNoSearchBackfill: envBool('KIA_CALL_CENTER_COMPLAINTS_NO_SEARCH_BACKFILL', false),
  openRoYearlySheetName: env('OPEN_RO_YEARLY_SHEET_NAME', 'Open RO Yearly'),
  openRoYearlyPageSize: env('OPEN_RO_YEARLY_PAGE_SIZE', '300'),
  openRoYearlyStartDate: env('OPEN_RO_YEARLY_START_DATE', '2025-03-01'),
  openRoYearlyPostSearchDelayMs: envDelayMs('OPEN_RO_YEARLY_POST_SEARCH_DELAY_MS', 5000),
  openRoYearlyBetweenChunksDelayMs: envDelayMs('OPEN_RO_YEARLY_BETWEEN_CHUNKS_DELAY_MS', 4000),
  demoJobCardsSheetName: env('DEMO_JOB_CARDS_SHEET_NAME', 'Demo Job Cards'),
  demoJobCardsPageSize: env('DEMO_JOB_CARDS_PAGE_SIZE', '300'),
  demoJobCardsWorkType: env('DEMO_JOB_CARDS_WORK_TYPE', 'Test Drive/CC Maintenance'),
  demoJobCardsBackfillEnabled: envBool('DEMO_JOB_CARDS_BACKFILL_ENABLED', false),
  demoJobCardsBackfillStartDate: env('DEMO_JOB_CARDS_BACKFILL_START_DATE', `${new Date().getFullYear()}-01-01`),
  demoJobCardsPostSearchDelayMs: envDelayMs('DEMO_JOB_CARDS_POST_SEARCH_DELAY_MS', 5000),
  demoJobCardsBetweenChunksDelayMs: envDelayMs('DEMO_JOB_CARDS_BETWEEN_CHUNKS_DELAY_MS', 4000),
  demoCarListSheetName: env('DEMO_CAR_LIST_SHEET_NAME', 'demo_car_list'),
  demoCarListPageSize: env('DEMO_CAR_LIST_PAGE_SIZE', '300'),
  demoCarListBackfillEnabled: envBool('DEMO_CAR_LIST_BACKFILL_ENABLED', false),
  demoCarListBackfillStartDate: env('DEMO_CAR_LIST_BACKFILL_START_DATE', '2025-01-01'),
  demoCarListPostSearchDelayMs: envDelayMs('DEMO_CAR_LIST_POST_SEARCH_DELAY_MS', 5000),
  demoCarListBetweenChunksDelayMs: envDelayMs('DEMO_CAR_LIST_BETWEEN_CHUNKS_DELAY_MS', 4000),
  serviceAppointmentSheetName: env('SERVICE_APPOINTMENT_SHEET_NAME', 'service_appointment'),
  serviceAppointmentPageSize: env('SERVICE_APPOINTMENT_PAGE_SIZE', '300'),
  serviceAppointmentBackfillEnabled: envBool('SERVICE_APPOINTMENT_BACKFILL_ENABLED', false),
  serviceAppointmentBackfillStartDate: env('SERVICE_APPOINTMENT_BACKFILL_START_DATE', '2026-05-01'),
  serviceAppointmentPostSearchDelayMs: envDelayMs('SERVICE_APPOINTMENT_POST_SEARCH_DELAY_MS', 5000),
  serviceAppointmentBetweenChunksDelayMs: envDelayMs('SERVICE_APPOINTMENT_BETWEEN_CHUNKS_DELAY_MS', 4000),
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
  advWiseLubricantsVasSheetName: env('ADV_WISE_LUBRICANTS_VAS_SHEET_NAME', 'Adv. wise lubricants & VAS'),
  advWiseLubricantsVasPageSize: env('ADV_WISE_LUBRICANTS_VAS_PAGE_SIZE', '300'),
  advWiseLubricantsVasPostSearchDelayMs: envDelayMs('ADV_WISE_LUBRICANTS_VAS_POST_SEARCH_DELAY_MS', 5000),
  operationWiseAnalysisSheetName: env('OPERATION_WISE_ANALYSIS_SHEET_NAME', 'Operation Wise Analysis Report'),
  operationWiseAnalysisPageSize: env('OPERATION_WISE_ANALYSIS_PAGE_SIZE', '300'),
  operationWiseAnalysisReportTypes: env('OPERATION_WISE_ANALYSIS_REPORT_TYPES', 'Operation,Part')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  operationWiseAnalysisBackfillEnabled: envBool('OPERATION_WISE_ANALYSIS_BACKFILL_ENABLED', false),
  operationWiseAnalysisBackfillStartDate: env('OPERATION_WISE_ANALYSIS_BACKFILL_START_DATE', '2025-03-01'),
  operationWiseAnalysisPostSearchDelayMs: envDelayMs('OPERATION_WISE_ANALYSIS_POST_SEARCH_DELAY_MS', 5000),
  operationWiseAnalysisBetweenChunksDelayMs: envDelayMs('OPERATION_WISE_ANALYSIS_BETWEEN_CHUNKS_DELAY_MS', 4000),
  operationWiseAnalysisAdvisorSheetName: env('OPERATION_WISE_ANALYSIS_ADVISOR_SHEET_NAME', 'Operation Wise Analysis Advisor Report'),
  operationWiseAnalysisAdvisorPageSize: env('OPERATION_WISE_ANALYSIS_ADVISOR_PAGE_SIZE', '300'),
  operationWiseAnalysisAdvisorBackfillEnabled: envBool('OPERATION_WISE_ANALYSIS_ADVISOR_BACKFILL_ENABLED', false),
  operationWiseAnalysisAdvisorBackfillStartDate: env('OPERATION_WISE_ANALYSIS_ADVISOR_BACKFILL_START_DATE', '2025-03-01'),
  operationWiseAnalysisAdvisorStartAtAdvisor: env('OPERATION_WISE_ANALYSIS_ADVISOR_START_AT_ADVISOR'),
  operationWiseAnalysisAdvisorStartAtDate: env('OPERATION_WISE_ANALYSIS_ADVISOR_START_AT_DATE'),
  operationWiseAnalysisAdvisorPostSearchDelayMs: envDelayMs('OPERATION_WISE_ANALYSIS_ADVISOR_POST_SEARCH_DELAY_MS', 5000),
  operationWiseAnalysisAdvisorBetweenChunksDelayMs: envDelayMs('OPERATION_WISE_ANALYSIS_ADVISOR_BETWEEN_CHUNKS_DELAY_MS', 4000),
  operationWiseAnalysisAdvisorBetweenAdvisorsDelayMs: envDelayMs('OPERATION_WISE_ANALYSIS_ADVISOR_BETWEEN_ADVISORS_DELAY_MS', 4000),
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
  rsaHeadless: envBool('RSA_HEADLESS', false),
  rsaUsePersistentProfile: envBool('RSA_USE_PERSISTENT_PROFILE', false),
  rsaUserDataDir: path.resolve(rootDir, env('RSA_USER_DATA_DIR', './storage/rsa-chrome-profile')),
  hmilCronSchedule: env('HMIL_CRON_SCHEDULE', '20 10-18 * * *'),
  hmilCurrentMonthOnly: envBool('HMIL_CURRENT_MONTH_ONLY', true),
  hmilLoginUrl: env('HMIL_DMS_URL', 'https://ndms.hmil.net/cmm/cmmi/selectLoginMain.dms'),
  hmilHomeUrl: env('HMIL_HOME_URL', 'https://ndms.hmil.net/cmm/cmmd/selectHome.dms'),
  hmilUserId: env('HMIL_USER_ID'),
  hmilPassword: env('HMIL_PASSWORD'),
  hmilForceLogin: envBool('HMIL_FORCE_LOGIN', true),
  hmilSessionCheckTimeoutMs: envInt('HMIL_SESSION_CHECK_TIMEOUT_MS', 8000),
  hmilSessionStatePath: path.resolve(rootDir, env('HMIL_SESSION_STATE_PATH', './storage/hmil-dms-state.json')),
  hmilDownloadDir: path.resolve(rootDir, env('HMIL_DOWNLOAD_DIR', './downloads/hmil')),
  hmilReportChunksDir: path.resolve(rootDir, env('HMIL_REPORT_CHUNKS_DIR', './downloads/report-chunks/hmil')),
  hmilDealerCodes: envList('HMIL_DEALER_CODES', 'N5216,N6844,N6845,N6846,N6847,N6848')
    .map(value => value.toUpperCase()),
  hmilReportsToRun: env('HMIL_REPORTS_TO_RUN', 'all'),
  hmilRepairOrderSheetName: env('HMIL_REPAIR_ORDER_SHEET_NAME', 'Hyundai Repair Order List'),
  hmilRepairOrderPageSize: env('HMIL_REPAIR_ORDER_PAGE_SIZE', '5000'),
  hmilRepairOrderStartDate: env('HMIL_REPAIR_ORDER_START_DATE', '2026-05-01'),
  hmilRepairOrderEndDate: env('HMIL_REPAIR_ORDER_END_DATE', '2026-05-31'),
  hmilRepairOrderPostSearchDelayMs: envDelayMs('HMIL_REPAIR_ORDER_POST_SEARCH_DELAY_MS', 0),
  hmilSecondaryUserId: env('HMIL_SECONDARY_USER_ID', 'MIS5216'),
  hmilSecondaryPassword: env('HMIL_SECONDARY_PASSWORD'),
  hmilWarrantyCronSchedule: env('HMIL_WARRANTY_CRON_SCHEDULE', '0 15 * * *'),
  hmilWarrantyCronTimezone: env('HMIL_WARRANTY_CRON_TIMEZONE', 'Asia/Kolkata'),
  hmilWarrantyHistoricalOtpProvider: env('HMIL_WARRANTY_HISTORICAL_OTP_PROVIDER', 'manual'),
  hmilWarrantyHistoricalStartDate: env('HMIL_WARRANTY_HISTORICAL_START_DATE', '2025-01-01'),
  hmilWarrantyPageSize: env('HMIL_WARRANTY_PAGE_SIZE', '300'),
  hmilWarrantyResume: envBool('HMIL_WARRANTY_RESUME', false),
  hmilWarrantyScheduledResume: envBool('HMIL_WARRANTY_SCHEDULED_RESUME', true),
  hmilWarrantySecondaryDealerCodes: envList(
    'HMIL_WARRANTY_SECONDARY_DEALER_CODES',
    'N5216,N6844,N6845,N6846,N6847,N6848'
  ).map(value => value.toUpperCase()),
  hmilWarrantyForceLogin: envBool('HMIL_WARRANTY_FORCE_LOGIN', false),
  hmilWarrantyPrimarySessionStatePath: path.resolve(
    rootDir,
    env('HMIL_WARRANTY_PRIMARY_SESSION_STATE_PATH', './storage/hmil-warranty-sahiltech-state.json')
  ),
  hmilWarrantySecondarySessionStatePath: path.resolve(
    rootDir,
    env('HMIL_WARRANTY_SECONDARY_SESSION_STATE_PATH', './storage/hmil-warranty-mis5216-state.json')
  ),
  hmilWarrantyDownloadDir: path.resolve(rootDir, env('HMIL_WARRANTY_DOWNLOAD_DIR', './downloads/hmil-warranty')),
  hmilWarrantyReportChunksDir: path.resolve(
    rootDir,
    env('HMIL_WARRANTY_REPORT_CHUNKS_DIR', './downloads/report-chunks/hmil-warranty')
  ),
  gdmsOtpLockDir: path.resolve(rootDir, env('GDMS_OTP_LOCK_DIR', './temp/gdms-otp-login.lock')),
  gdmsOtpLockEnabled: envBool('GDMS_OTP_LOCK_ENABLED', true),
  gdmsOtpLockTimeoutMs: envInt('GDMS_OTP_LOCK_TIMEOUT_MS', 300000),
  gdmsOtpLockStaleMs: envInt('GDMS_OTP_LOCK_STALE_MS', 600000),
  amPlatinumCronSchedule: env('AM_PLATINUM_CRON_SCHEDULE', '10 16 * * *'),
  amPlatinumCronTimezone: env('AM_PLATINUM_CRON_TIMEZONE', env('KIA_CRON_TIMEZONE', 'Asia/Kolkata')),
  amPlatinumCurrentMonthOnly: envBool('AM_PLATINUM_CURRENT_MONTH_ONLY', true),
  amPlatinumLoginUrl: env('AM_PLATINUM_DMS_URL', env('HMIL_DMS_URL', 'https://ndms.hmil.net/cmm/cmmi/selectLoginMain.dms')),
  amPlatinumHomeUrl: env('AM_PLATINUM_HOME_URL', env('HMIL_HOME_URL', 'https://ndms.hmil.net/cmm/cmmd/selectHome.dms')),
  amPlatinumUserId: env('AM_PLATINUM_USER_ID'),
  amPlatinumPassword: env('AM_PLATINUM_PASSWORD'),
  amPlatinumHistoricalUserId: env('AM_PLATINUM_HISTORICAL_USER_ID', 'MIS12345'),
  amPlatinumHistoricalPassword: env('AM_PLATINUM_HISTORICAL_PASSWORD', env('AM_PLATINUM_PASSWORD')),
  amPlatinumHistoricalCutoffDate: env('AM_PLATINUM_HISTORICAL_CUTOFF_DATE', '2024-03-01'),
  amPlatinumRajouriMis1988StartDate: env('AM_PLATINUM_RAJOURI_MIS1988_START_DATE', '2024-01-01'),
  amPlatinumPost2024DealerCode: env('AM_PLATINUM_POST_2024_DEALER_CODE', 'N6250').trim().toUpperCase(),
  amPlatinumHistoricalSessionStatePath: path.resolve(
    rootDir,
    env('AM_PLATINUM_HISTORICAL_SESSION_STATE_PATH', './storage/am-platinum-historical-dms-state.json')
  ),
  amPlatinumForceLogin: envBool('AM_PLATINUM_FORCE_LOGIN', true),
  amPlatinumSessionCheckTimeoutMs: envInt('AM_PLATINUM_SESSION_CHECK_TIMEOUT_MS', envInt('HMIL_SESSION_CHECK_TIMEOUT_MS', 8000)),
  amPlatinumSessionStatePath: path.resolve(rootDir, env('AM_PLATINUM_SESSION_STATE_PATH', './storage/am-platinum-dms-state.json')),
  amPlatinumDownloadDir: path.resolve(rootDir, env('AM_PLATINUM_DOWNLOAD_DIR', './downloads/am-platinum')),
  amPlatinumReportChunksDir: path.resolve(rootDir, env('AM_PLATINUM_REPORT_CHUNKS_DIR', './downloads/report-chunks/am-platinum')),
  amPlatinumDealerCodes: envList('AM_PLATINUM_DEALER_CODES', '')
    .map(value => value.toUpperCase()),
  amPlatinumReportsToRun: env('AM_PLATINUM_REPORTS_TO_RUN', 'all'),
  amPlatinumRepairOrderSheetName: env('AM_PLATINUM_REPAIR_ORDER_SHEET_NAME', 'AM Platinum Repair Order List'),
  amPlatinumRepairOrderPageSize: env('AM_PLATINUM_REPAIR_ORDER_PAGE_SIZE', env('HMIL_REPAIR_ORDER_PAGE_SIZE', '5000')),
  amPlatinumRepairOrderStartDate: env('AM_PLATINUM_REPAIR_ORDER_START_DATE', env('HMIL_REPAIR_ORDER_START_DATE', '2026-05-01')),
  amPlatinumRepairOrderEndDate: env('AM_PLATINUM_REPAIR_ORDER_END_DATE', env('HMIL_REPAIR_ORDER_END_DATE', '2026-05-31')),
  amPlatinumRepairOrderPostSearchDelayMs: envDelayMs('AM_PLATINUM_REPAIR_ORDER_POST_SEARCH_DELAY_MS', envInt('HMIL_REPAIR_ORDER_POST_SEARCH_DELAY_MS', 0)),
  amPlatinumHistoricalOtpProvider: env('AM_PLATINUM_HISTORICAL_OTP_PROVIDER', 'manual')
};

export function requireSecret(name, value) {
  if (!value) {
    throw new Error(`${name} is required. Add it to .env before running the automation.`);
  }
}

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function envScoped(name, fallback = '') {
  const suffixes = [process.env.COMPUTERNAME, process.env.USERNAME]
    .map(value => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '_'))
    .filter(Boolean);

  for (const suffix of suffixes) {
    const value = process.env[`${name}_${suffix}`];
    if (value != null && value !== '') return value;
  }

  return env(name, fallback);
}

function envInt(name, fallback) {
  const raw = envScoped(name);
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

function todayIsoLocal() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0')
  ].join('-');
}

const defaultHmilPrimaryDealers = 'N5203,N5701,N5804,N5806,N6815,N6819,N6826';
const defaultHmilSecondaryDealers = 'N5216,N6844,N6845,N6846,N6847,N6848';

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
  otpWebhookBaseUrl: envScoped('OTP_WEBHOOK_BASE_URL', 'http://127.0.0.1:3333'),
  otpWebhookToken: env('OTP_WEBHOOK_TOKEN', 'change-me'),
  otpWebhookHost: envScoped('OTP_WEBHOOK_HOST', '0.0.0.0'),
  otpWebhookPort: envInt('OTP_WEBHOOK_PORT', envInt('PORT', 3333)),
  otpWebhookDebug: envBool('OTP_WEBHOOK_DEBUG', false),
  otpFreshnessGraceMs: envInt('OTP_FRESHNESS_GRACE_MS', 0),
  cronSchedule: env('CRON_SCHEDULE', '0 9-18 * * *'),
  regularReportsCronSchedule: env('REGULAR_REPORTS_CRON_SCHEDULE', env('CRON_SCHEDULE', '0 9-18 * * *')),
  rsaReportCronSchedule: env('RSA_REPORT_CRON_SCHEDULE', '5 10 * * *'),
  openRoYearlyCronSchedule: env('OPEN_RO_YEARLY_CRON_SCHEDULE', '10 18 * * *'),
  kiaCallCenterComplaintsCronSchedule: env('KIA_CALL_CENTER_COMPLAINTS_CRON_SCHEDULE', '25 18 * * *'),
  demoJobCardsCronSchedule: env('DEMO_JOB_CARDS_CRON_SCHEDULE', '30 10,18 * * *'),
  demoCarListCronSchedule: env('DEMO_CAR_LIST_CRON_SCHEDULE', '30 15 * * 1'),
  serviceAppointmentCronSchedule: env('SERVICE_APPOINTMENT_CRON_SCHEDULE', '45 18 * * *'),
  roBillingCronSchedule: env('RO_BILLING_CRON_SCHEDULE', '0 9-18 * * *'),
  kiaBookingReportCronSchedule: env('KIA_BOOKING_REPORT_CRON_SCHEDULE', '50 18 * * *'),
  kiaSalesReportCronSchedule: env('KIA_SALES_REPORT_CRON_SCHEDULE', '50 18 * * *'),
  kiaEnquiryReportCronSchedule: env('KIA_ENQUIRY_REPORT_CRON_SCHEDULE', '50 18 * * *'),
  kiaAccessoriesCounterSalesCronSchedule: env('KIA_ACCESSORIES_COUNTER_SALES_CRON_SCHEDULE', '50 18 * * *'),
  kiaPurchaseReportCronSchedule: env('KIA_PURCHASE_REPORT_CRON_SCHEDULE', '20 19 * * *'),
  kiaReceiptReportCronSchedule: env('KIA_RECEIPT_REPORT_CRON_SCHEDULE', '25 19 * * *'),
  kiaStockManagementCronSchedule: env('KIA_STOCK_MANAGEMENT_CRON_SCHEDULE', '20 19 * * *'),
  hmilRepairOrderCronSchedule: env('HMIL_REPAIR_ORDER_CRON_SCHEDULE', '20 16 * * *'),
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
  playwrightBrowserChannel: env('PLAYWRIGHT_BROWSER_CHANNEL', '').trim(),
  playwrightUsePersistentContext: envBool('PLAYWRIGHT_USE_PERSISTENT_CONTEXT', false),
  playwrightUserDataDir: path.resolve(rootDir, env('PLAYWRIGHT_USER_DATA_DIR', './storage/playwright-browser-profile')),
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
  kiaBookingReportSheetName: env('KIA_BOOKING_REPORT_SHEET_NAME', 'kia_booking_report'),
  kiaBookingReportPageSize: env('KIA_BOOKING_REPORT_PAGE_SIZE', '300'),
  kiaBookingReportBackfillStartDate: env('KIA_BOOKING_REPORT_BACKFILL_START_DATE', '2025-01-01'),
  kiaBookingReportPostSearchDelayMs: envDelayMs('KIA_BOOKING_REPORT_POST_SEARCH_DELAY_MS', 5000),
  kiaBookingReportBetweenChunksDelayMs: envDelayMs('KIA_BOOKING_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  kiaSalesReportSheetName: env('KIA_SALES_REPORT_SHEET_NAME', 'kia_sales_report'),
  kiaSalesReportPageSize: env('KIA_SALES_REPORT_PAGE_SIZE', '300'),
  kiaSalesReportBackfillStartDate: env('KIA_SALES_REPORT_BACKFILL_START_DATE', '2025-01-01'),
  kiaSalesReportPostSearchDelayMs: envDelayMs('KIA_SALES_REPORT_POST_SEARCH_DELAY_MS', 5000),
  kiaSalesReportBetweenChunksDelayMs: envDelayMs('KIA_SALES_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  hyundaiSalesReportSheetName: env('HYUNDAI_SALES_REPORT_SHEET_NAME', 'hyundai_sales_report'),
  hyundaiSalesReportPageSize: env('HYUNDAI_SALES_REPORT_PAGE_SIZE', '1000'),
  hyundaiSalesReportBackfillStartDate: env('HYUNDAI_SALES_REPORT_BACKFILL_START_DATE', '2021-01-01'),
  hyundaiSalesReportPostSearchDelayMs: envDelayMs('HYUNDAI_SALES_REPORT_POST_SEARCH_DELAY_MS', 5000),
  hyundaiSalesReportBetweenChunksDelayMs: envDelayMs('HYUNDAI_SALES_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  hyundaiPurchaseReportSheetName: env('HYUNDAI_PURCHASE_REPORT_SHEET_NAME', 'hyundai_purchase_report'),
  hyundaiPurchaseReportPageSize: env('HYUNDAI_PURCHASE_REPORT_PAGE_SIZE', '300'),
  hyundaiPurchaseReportBackfillStartDate: env('HYUNDAI_PURCHASE_REPORT_BACKFILL_START_DATE', '2021-01-01'),
  hyundaiPurchaseReportPostSearchDelayMs: envDelayMs('HYUNDAI_PURCHASE_REPORT_POST_SEARCH_DELAY_MS', 5000),
  hyundaiPurchaseReportBetweenChunksDelayMs: envDelayMs('HYUNDAI_PURCHASE_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  hyundaiReceiptReportSheetName: env('HYUNDAI_RECEIPT_REPORT_SHEET_NAME', 'hyundai_receipt_report'),
  hyundaiReceiptReportPageSize: env('HYUNDAI_RECEIPT_REPORT_PAGE_SIZE', '1000'),
  hyundaiReceiptReportBackfillStartDate: env('HYUNDAI_RECEIPT_REPORT_BACKFILL_START_DATE', '2021-01-01'),
  hyundaiReceiptReportPostSearchDelayMs: envDelayMs('HYUNDAI_RECEIPT_REPORT_POST_SEARCH_DELAY_MS', 5000),
  hyundaiReceiptReportBetweenChunksDelayMs: envDelayMs('HYUNDAI_RECEIPT_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  hyundaiBookingReportPageSize: env('HYUNDAI_BOOKING_REPORT_PAGE_SIZE', '300'),
  hyundaiBookingReportPostSearchDelayMs: envDelayMs('HYUNDAI_BOOKING_REPORT_POST_SEARCH_DELAY_MS', 5000),
  hyundaiBookingReportBetweenChunksDelayMs: envDelayMs('HYUNDAI_BOOKING_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  hyundaiEnquiryReportSheetName: env('HYUNDAI_ENQUIRY_REPORT_SHEET_NAME', 'hyundai_enquiry_report'),
  hyundaiEnquiryReportPageSize: env('HYUNDAI_ENQUIRY_REPORT_PAGE_SIZE', '1000'),
  hyundaiEnquiryReportBackfillStartDate: env('HYUNDAI_ENQUIRY_REPORT_BACKFILL_START_DATE', '2021-01-01'),
  hyundaiEnquiryReportPostSearchDelayMs: envDelayMs('HYUNDAI_ENQUIRY_REPORT_POST_SEARCH_DELAY_MS', 5000),
  hyundaiEnquiryReportBetweenChunksDelayMs: envDelayMs('HYUNDAI_ENQUIRY_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),




  kiaEnquiryReportSheetName: env('KIA_ENQUIRY_REPORT_SHEET_NAME', 'kia_enquiry_report'),
  kiaEnquiryReportPageSize: env('KIA_ENQUIRY_REPORT_PAGE_SIZE', '300'),
  kiaEnquiryReportBackfillStartDate: env('KIA_ENQUIRY_REPORT_BACKFILL_START_DATE', '2025-01-01'),
  kiaEnquiryReportPostSearchDelayMs: envDelayMs('KIA_ENQUIRY_REPORT_POST_SEARCH_DELAY_MS', 5000),
  kiaEnquiryReportBetweenChunksDelayMs: envDelayMs('KIA_ENQUIRY_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  kiaAccessoriesCounterSalesSheetName: env('KIA_ACCESSORIES_COUNTER_SALES_SHEET_NAME', 'kia_accessories_counter_sales_report'),
  kiaAccessoriesCounterSalesPageSize: env('KIA_ACCESSORIES_COUNTER_SALES_PAGE_SIZE', '300'),
  kiaAccessoriesCounterSalesBackfillStartDate: env('KIA_ACCESSORIES_COUNTER_SALES_BACKFILL_START_DATE', '2025-01-01'),
  kiaAccessoriesCounterSalesPostSearchDelayMs: envDelayMs('KIA_ACCESSORIES_COUNTER_SALES_POST_SEARCH_DELAY_MS', 5000),
  kiaAccessoriesCounterSalesBetweenChunksDelayMs: envDelayMs('KIA_ACCESSORIES_COUNTER_SALES_BETWEEN_CHUNKS_DELAY_MS', 4000),
  kiaPurchaseReportSheetName: env('KIA_PURCHASE_REPORT_SHEET_NAME', 'kia_purchase_report'),
  kiaPurchaseReportPageSize: env('KIA_PURCHASE_REPORT_PAGE_SIZE', '300'),
  kiaPurchaseReportBackfillStartDate: env('KIA_PURCHASE_REPORT_BACKFILL_START_DATE', '2025-01-01'),
  kiaPurchaseReportPostSearchDelayMs: envDelayMs('KIA_PURCHASE_REPORT_POST_SEARCH_DELAY_MS', 5000),
  kiaPurchaseReportBetweenChunksDelayMs: envDelayMs('KIA_PURCHASE_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  kiaReceiptReportSheetName: env('KIA_RECEIPT_REPORT_SHEET_NAME', 'kia_receipt_report'),
  kiaReceiptReportPageSize: env('KIA_RECEIPT_REPORT_PAGE_SIZE', '300'),
  kiaReceiptReportBackfillStartDate: env('KIA_RECEIPT_REPORT_BACKFILL_START_DATE', '2025-01-01'),
  kiaReceiptReportPostSearchDelayMs: envDelayMs('KIA_RECEIPT_REPORT_POST_SEARCH_DELAY_MS', 5000),
  kiaReceiptReportBetweenChunksDelayMs: envDelayMs('KIA_RECEIPT_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  kiaStockManagementSheetName: env('KIA_STOCK_MANAGEMENT_SHEET_NAME', 'kia_stock_management'),
  kiaStockManagementPageSize: env('KIA_STOCK_MANAGEMENT_PAGE_SIZE', '300'),
  kiaStockManagementPostSearchDelayMs: envDelayMs('KIA_STOCK_MANAGEMENT_POST_SEARCH_DELAY_MS', 5000),
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
  kiaSafetyCronSchedule: env('KIA_SAFETY_CRON_SCHEDULE', '0 10 * * *'),
  kiaSafetyDailyCronSchedule: env('KIA_SAFETY_DAILY_CRON_SCHEDULE', '0 10 * * *'),
  kiaSafetyUrl: env('KIA_SAFETY_URL', 'https://www.kiasafety.com/VISOF/Policy/VSAddPolDealerApproval.aspx'),
  kiaSafetyLoginUrl: env('KIA_SAFETY_LOGIN_URL', 'https://www.kiasafety.com/VISOF/Login.aspx'),
  kiaSafetyUserId: env('KIA_SAFETY_USER_ID', 'JK40202'),
  kiaSafetyPassword: env('KIA_SAFETY_PASSWORD', 'Abhi@123'),
  kiaSafetySessionStatePath: path.resolve(rootDir, env('KIA_SAFETY_SESSION_STATE_PATH', './storage/kia-safety-state.json')),
  kiaSafetySheetName: env('KIA_SAFETY_SHEET_NAME', 'Kia Insurance'),
  kiaSafetyTableHeaders: envList('KIA_SAFETY_TABLE_HEADERS', 'Sno,BRAND,State,Location,DealerCode,Dealer,policy_effective_date,Policy_expiry_date,InsuranceCompany,PolicyNo,PolicyType,Class,ProductType,Model,FuelType,Variant,VinNo,EngineNo,Create_Date,PaymentGenerated,PaymentNo,PaymentMode,ODDiscount,Cancelled,Cancelled_Date,Endorsed,ChequeNo,TotalIDV,NetODPremiumA,NetPremium,IGST,CGST,SGST,UGST,GrossPremium,CUSTOMER_NAME,Package_Name,NCB_SLAB_PER,VEH_REGIST_NO,MFG_YEAR,ACH_CC_Status,Prev_POLICY_NO,Prev_IC_NAME,Quotation_No,IS_LONGTERM,IS_CRP'),
  kiaSafetyHistoricalBackfillEnabled: envBool('KIA_SAFETY_HISTORICAL_BACKFILL_ENABLED', false),
  kiaSafetyBackfillStartDate: env('KIA_SAFETY_BACKFILL_START_DATE', '2025-01-01'),
  kiaSafetyBackfillEndDate: env('KIA_SAFETY_BACKFILL_END_DATE', '2026-05-31'),
  kiaSafetyDailyModeEnabled: envBool('KIA_SAFETY_DAILY_MODE_ENABLED', true),
  hmilCronSchedule: env('HMIL_CRON_SCHEDULE', '20 16 * * *'),
  hmilCurrentMonthOnly: envBool('HMIL_CURRENT_MONTH_ONLY', true),
  hmilLoginUrl: env('HMIL_DMS_URL', 'https://ndms.hmil.net/cmm/cmmi/selectLoginMain.dms'),
  hmilHomeUrl: env('HMIL_HOME_URL', 'https://ndms.hmil.net/cmm/cmmd/selectHome.dms'),
  hmilUserId: env('HMIL_USER_ID'),
  hmilPassword: env('HMIL_PASSWORD'),
  hmilForceLogin: envBool('HMIL_FORCE_LOGIN', true),
  hmilLoginRetries: envInt('HMIL_LOGIN_RETRIES', 0),
  hmilSessionCheckTimeoutMs: envInt('HMIL_SESSION_CHECK_TIMEOUT_MS', 8000),
  hmilSessionStatePath: path.resolve(rootDir, env('HMIL_SESSION_STATE_PATH', './storage/hmil-dms-state.json')),
  hmilSecondarySessionStatePath: path.resolve(
    rootDir,
    env('HMIL_SECONDARY_SESSION_STATE_PATH', './storage/hmil-secondary-dms-state.json')
  ),
  hmilDownloadDir: path.resolve(rootDir, env('HMIL_DOWNLOAD_DIR', './downloads/hmil')),
  hmilReportChunksDir: path.resolve(rootDir, env('HMIL_REPORT_CHUNKS_DIR', './downloads/report-chunks/hmil')),
  hmilPrimaryDealerCodes: envList('HMIL_PRIMARY_DEALER_CODES', defaultHmilPrimaryDealers)
    .map(value => value.toUpperCase()),
  hmilSecondaryDealerCodes: envList(
    'HMIL_SECONDARY_DEALER_CODES',
    env('HMIL_DEALER_CODES', defaultHmilSecondaryDealers)
  )
    .map(value => value.toUpperCase()),
  hmilDealerCodes: envList('HMIL_DEALER_CODES', env('HMIL_PRIMARY_DEALER_CODES', defaultHmilPrimaryDealers))
    .map(value => value.toUpperCase()),
  hmilReportsToRun: env('HMIL_REPORTS_TO_RUN', 'all'),
  hmilRepairOrderSheetName: env('HMIL_REPAIR_ORDER_SHEET_NAME', 'Hyundai Repair Order List'),
  hmilRepairOrderPageSize: env('HMIL_REPAIR_ORDER_PAGE_SIZE', '5000'),
  hmilRepairOrderUseActiveDealerOnly: envBool('HMIL_REPAIR_ORDER_USE_ACTIVE_DEALER_ONLY', true),
  hmilRepairOrderStartDate: env('HMIL_REPAIR_ORDER_START_DATE', '2025-01-01'),
  hmilRepairOrderEndDate: env('HMIL_REPAIR_ORDER_END_DATE', todayIsoLocal()),
  hmilPrimaryRepairOrderStartDate: env('HMIL_PRIMARY_REPAIR_ORDER_START_DATE', env('HMIL_REPAIR_ORDER_START_DATE', '2025-01-01')),
  hmilPrimaryRepairOrderEndDate: env('HMIL_PRIMARY_REPAIR_ORDER_END_DATE', '2026-04-25'),
  hmilSecondaryRepairOrderStartDate: env('HMIL_SECONDARY_REPAIR_ORDER_START_DATE', '2026-04-25'),
  hmilSecondaryRepairOrderEndDate: env('HMIL_SECONDARY_REPAIR_ORDER_END_DATE', env('HMIL_REPAIR_ORDER_END_DATE', todayIsoLocal())),
  hmilRepairOrderPostSearchDelayMs: envDelayMs('HMIL_REPAIR_ORDER_POST_SEARCH_DELAY_MS', 0),
  hmilSecondaryUserId: env('HMIL_SECONDARY_USER_ID', 'MIS5216'),
  hmilSecondaryPassword: env('HMIL_SECONDARY_PASSWORD'),
  // HMIL DMS login used ONLY by the Booking Report. Deliberately no password default —
  // it must come from .env so the credential never lives in source.
  hmilBookingUserId: env('HMIL_BOOKING_USER_ID', 'AMMIS'),
  hmilBookingPassword: env('HMIL_BOOKING_PASSWORD'),
  hmilBookingSessionStatePath: path.resolve(
    rootDir,
    env('HMIL_BOOKING_SESSION_STATE_PATH', './storage/hmil-booking-dms-state.json')
  ),
  hmilBookingDealerCodes: envList('HMIL_BOOKING_DEALER_CODES', '')
    .map(value => value.toUpperCase()),
  hmilWarrantyCronSchedule: env('HMIL_WARRANTY_CRON_SCHEDULE', '0 15 * * *'),
  hmilWarrantyCronTimezone: env('HMIL_WARRANTY_CRON_TIMEZONE', 'Asia/Kolkata'),
  hmilWarrantyHistoricalOtpProvider: env('HMIL_WARRANTY_HISTORICAL_OTP_PROVIDER', 'manual'),
  hmilWarrantyHistoricalStartDate: env('HMIL_WARRANTY_HISTORICAL_START_DATE', '2025-01-01'),
  hmilWarrantyPageSize: env('HMIL_WARRANTY_PAGE_SIZE', '1000'),
  hmilWarrantyExportDownloadTimeoutMs: envInt('HMIL_WARRANTY_EXPORT_DOWNLOAD_TIMEOUT_MS', 30000),
  hmilWarrantyMaxRunMs: envInt('HMIL_WARRANTY_MAX_RUN_MS', 10800000),
  hmilWarrantyResume: envBool('HMIL_WARRANTY_RESUME', false),
  hmilWarrantyScheduledResume: envBool('HMIL_WARRANTY_SCHEDULED_RESUME', true),
  hmilWarrantyLoginRetries: envInt('HMIL_WARRANTY_LOGIN_RETRIES', 0),
  hmilWarrantySecondaryDealerCodes: envList(
    'HMIL_WARRANTY_SECONDARY_DEALER_CODES',
    env('HMIL_SECONDARY_DEALER_CODES', defaultHmilSecondaryDealers)
  ).map(value => value.toUpperCase()),
  hmilWarrantyForceLogin: envBool('HMIL_WARRANTY_FORCE_LOGIN', false),
  hmilWarrantyPrimarySessionStatePath: path.resolve(
    rootDir,
    env('HMIL_WARRANTY_PRIMARY_SESSION_STATE_PATH', env('HMIL_SESSION_STATE_PATH', './storage/hmil-dms-state.json'))
  ),
  hmilWarrantySecondarySessionStatePath: path.resolve(
    rootDir,
    env(
      'HMIL_WARRANTY_SECONDARY_SESSION_STATE_PATH',
      env('HMIL_SECONDARY_SESSION_STATE_PATH', './storage/hmil-secondary-dms-state.json')
    )
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
  amPlatinumLoginRetries: envInt('AM_PLATINUM_LOGIN_RETRIES', 0),
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
  amPlatinumHistoricalOtpProvider: env('AM_PLATINUM_HISTORICAL_OTP_PROVIDER', 'manual'),

  // Interakt — WhatsApp inbox (app.interakt.ai) used for social-media leads.
  // No password default: it must come from .env so the credential never lives in source.
  interaktLoginUrl: env('INTERAKT_LOGIN_URL', 'https://app.interakt.ai/login'),
  interaktUserId: env('INTERAKT_USER_ID', 'data@amgroupind.com'),
  interaktPassword: env('INTERAKT_PASSWORD'),
  interaktSessionStatePath: path.resolve(rootDir, env('INTERAKT_SESSION_STATE_PATH', './storage/interakt-state.json')),
  interaktInboxUrl: env('INTERAKT_INBOX_URL', 'https://app.interakt.ai/inbox'),
  interaktLeadMaxAgeDays: envInt('INTERAKT_LEAD_MAX_AGE_DAYS', 7),
  interaktLeadsSheetName: env('INTERAKT_LEADS_SHEET_NAME', 'social_media_leads'),
  interaktCronSchedule: env('INTERAKT_CRON_SCHEDULE', '*/10 9-18 * * *'),

  // HIIB — Hyundai insurance broker portal (MISP at ha.hiib.in).
  // Separate portal from HMIL DMS: its own login form, its own captcha, its own session.
  hiibBaseUrl: env('HIIB_BASE_URL', 'https://ha.hiib.in'),
  hiibLoginUrl: env('HIIB_LOGIN_URL', 'https://ha.hiib.in/'),
  hiibDashboardUrl: env('HIIB_DASHBOARD_URL', 'https://ha.hiib.in/Dashboard/Welcome'),
  hiibPolicySummaryReportUrl: env(
    'HIIB_POLICY_SUMMARY_REPORT_URL',
    'https://ha.hiib.in/Report/Report/policysummaryreport'
  ),
  // No hardcoded fallbacks: this file is tracked by git, and a committed credential
  // pair that used to sit here is rejected by the portal anyway.
  hiibUserId: env('HIIB_USER_ID'),
  hiibPassword: env('HIIB_PASSWORD'),
  // Second portal login, locked server-side to dealer N5211 (AM Platinum).
  hiibPlatinumUserId: env('HIIB_PLATINUM_USER_ID'),
  hiibPlatinumPassword: env('HIIB_PLATINUM_PASSWORD'),
  hiibPlatinumSessionStatePath: path.resolve(
    rootDir,
    env('HIIB_PLATINUM_SESSION_STATE_PATH', './storage/hiib-platinum-state.json')
  ),
  // Platinum lands in its own table, separate from the N5203 Hyundai data.
  hiibPlatinumSheetName: env('HIIB_PLATINUM_SHEET_NAME', 'am_platinum_insurance_policy_summary'),
  // Dealer logins are locked to one dealer server-side; leave blank to read it off the page.
  hiibDealerCode: env('HIIB_DEALER_CODE', '').trim().toUpperCase(),
  // 'auto' reads the captcha answer the portal exposes client-side; 'manual' waits for a human to type it.
  hiibCaptchaMode: env('HIIB_CAPTCHA_MODE', 'auto').trim().toLowerCase(),
  hiibManualCaptchaWaitMs: envInt('HIIB_MANUAL_CAPTCHA_WAIT_MS', 60000),
  hiibManualCaptchaPollMs: envInt('HIIB_MANUAL_CAPTCHA_POLL_MS', 1000),
  hiibHeadless: envBool('HIIB_HEADLESS', envBool('HEADLESS', false)),
  hiibForceLogin: envBool('HIIB_FORCE_LOGIN', false),
  hiibLoginRetries: envInt('HIIB_LOGIN_RETRIES', 2),
  hiibSessionCheckTimeoutMs: envInt('HIIB_SESSION_CHECK_TIMEOUT_MS', 20000),
  hiibOtpProvider: env('HIIB_OTP_PROVIDER', env('OTP_PROVIDER', 'manual')),
  hiibOtpWaitMs: envInt('HIIB_OTP_WAIT_MS', 120000),
  hiibSessionStatePath: path.resolve(rootDir, env('HIIB_SESSION_STATE_PATH', './storage/hiib-insurance-state.json')),
  hiibDownloadDir: path.resolve(rootDir, env('HIIB_DOWNLOAD_DIR', './downloads/hiib-insurance')),
  hiibReportChunksDir: path.resolve(rootDir, env('HIIB_REPORT_CHUNKS_DIR', './downloads/report-chunks/hiib-insurance')),
  hiibDateFormat: env('HIIB_DATE_FORMAT', 'DD/MM/YYYY'),
  hiibCronSchedule: env('HIIB_CRON_SCHEDULE', '30 18 * * *'),
  hiibCronTimezone: env('HIIB_CRON_TIMEZONE', env('KIA_CRON_TIMEZONE', 'Asia/Kolkata')),
  hyundaiInsuranceReportSheetName: env('HYUNDAI_INSURANCE_REPORT_SHEET_NAME', 'hyundai_insurance_policy_summary'),
  hyundaiInsuranceReportBackfillStartDate: env('HYUNDAI_INSURANCE_REPORT_BACKFILL_START_DATE', '2024-04-01'),
  // The portal's own Validate() rejects ranges wider than 62 days; stay just under it.
  hyundaiInsuranceReportChunkDays: envInt('HYUNDAI_INSURANCE_REPORT_CHUNK_DAYS', 60),
  hyundaiInsuranceReportPostSearchDelayMs: envDelayMs('HYUNDAI_INSURANCE_REPORT_POST_SEARCH_DELAY_MS', 5000),
  hyundaiInsuranceReportBetweenChunksDelayMs: envDelayMs('HYUNDAI_INSURANCE_REPORT_BETWEEN_CHUNKS_DELAY_MS', 4000),
  // Successful exports return in 1-2s; a long wait here just stalls the run before
  // the grid-scraping fallback takes over.
  hyundaiInsuranceReportDownloadTimeoutMs: envInt('HYUNDAI_INSURANCE_REPORT_DOWNLOAD_TIMEOUT_MS', 60000),
  hyundaiInsuranceReportExportAttempts: envInt('HYUNDAI_INSURANCE_REPORT_EXPORT_ATTEMPTS', 2),
  // The portal allows only ~3 CSV exports per day, so rows are read from the
  // DataTables grid instead. The grid exposes the same ~79 columns.
  hyundaiInsuranceReportUseCsvExport: envBool('HYUNDAI_INSURANCE_REPORT_USE_CSV_EXPORT', false)
};


export function requireSecret(name, value) {
  if (!value) {
    throw new Error(`${name} is required. Add it to .env before running the automation.`);
  }
}

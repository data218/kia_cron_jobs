# KIA Cron Automation KT Handover

Last updated: 2026-05-29

This document explains the current KIA automation project so another developer can take over, operate it, debug failures, and add new report crons without needing the full chat history.

Do not add real passwords, Supabase keys, OTP tokens, ngrok auth tokens, or user credentials to this file.

## 1. Project Summary

This project is a long-running Node.js automation system for downloading KIA DMS and RSA portal reports, parsing exported Excel files, and saving the data into Supabase relational tables for Business Excellence dashboards.

The automation uses:

- Node.js
- Playwright
- PM2
- node-cron
- Supabase JS SDK
- Direct PostgreSQL client
- ExcelJS
- Express webhook server for Android SMS Forwarder OTP
- ngrok for public OTP webhook tunneling
- Pino logs
- Nodemailer failure alerts

The system is not serverless. It is designed to run continuously on a local machine or VPS under PM2.

## 2. High-Level Flow

The normal runtime flow is:

1. PM2 keeps the scheduler, webhook server, and ngrok tunnel alive.
2. node-cron triggers the correct scheduler lane.
3. The scheduler prevents overlapping runs with a global lock.
4. The scheduler logs into KIA DMS when selected reports require it.
5. OTP is received through Android SMS Forwarder -> ngrok URL -> local Express webhook.
6. Reports run sequentially, never in parallel.
7. Each report navigates to its DMS/RSA page, applies filters, searches, handles pagination, and exports Excel.
8. Export files are stored temporarily under `downloads/report-chunks/`.
9. Excel files are parsed and merged.
10. Rows are saved into dedicated Supabase relational tables.
11. Duplicate rows are skipped/updated through `row_hash`.
12. Temporary files are deleted only after successful database save.
13. Logs and health status are written under `logs/`.

## 3. Process Management

PM2 config file:

- `ecosystem.config.cjs`

PM2 processes:

- `kia-cron-job`: runs `src/cron/scheduler.js --scheduler`
- `kia-otp-webhook`: runs `src/otp/webhook-server.js`
- `kia-ngrok`: runs `src/otp/ngrok-tunnel.js`

Useful commands:

```powershell
pm2 status
pm2 logs kia-cron-job
pm2 logs kia-otp-webhook
pm2 logs kia-ngrok
pm2 restart kia-cron-job --update-env
pm2 restart kia-otp-webhook --update-env
pm2 restart kia-ngrok --update-env
pm2 save
```

Current local webhook health URLs:

```text
http://127.0.0.1:3333/
https://endocentric-luna-plectognathic.ngrok-free.dev/
```

The public SMS Forwarder URL format is:

```text
https://endocentric-luna-plectognathic.ngrok-free.dev/sms?token=<OTP_WEBHOOK_TOKEN>
```

If `kia-ngrok` fails with `ERR_NGROK_334`, another `ngrok.exe` process is already using the reserved URL. Stop the stray ngrok process and restart `kia-ngrok` under PM2.

## 4. Scheduler Design

Scheduler file:

- `src/cron/scheduler.js`

Report registry:

- `src/reports/index.js`

Current scheduler lanes:

- Regular lane: every 30 minutes from 9 AM to 6 PM.
- Open RO Yearly lane: once daily at 6 PM.
- Kia Call Center Complaints lane: once daily at 6 PM.

Relevant `.env` schedules:

```env
REGULAR_REPORTS_CRON_SCHEDULE=*/30 9-18 * * *
OPEN_RO_YEARLY_CRON_SCHEDULE=0 18 * * *
KIA_CALL_CENTER_COMPLAINTS_CRON_SCHEDULE=0 18 * * *
```

Important behavior:

- Reports are sequential.
- No reports run in parallel.
- A global `running` lock prevents overlapping schedule ticks.
- If one report fails after retries, the scheduler logs the failure and continues with the remaining reports.
- Health status is written to `logs/health.json`.

## 5. Report Execution Modes

Active report selection is controlled from `.env`.

Normal production mode:

```env
REPORTS_TO_RUN=all
TEST_SINGLE_REPORT=false
TEST_REPORT_NAME=
DRY_RUN_REPORTS=false
```

Single report testing mode:

```env
TEST_SINGLE_REPORT=true
TEST_REPORT_NAME=ew-report
```

Dry sequence test:

```env
DRY_RUN_REPORTS=true
```

Run:

```powershell
npm run test:sequence
```

One-time run:

```powershell
npm run reports
```

Syntax check:

```powershell
npm run check
```

## 6. Current Report Inventory

### RO Billing Report

- Report id: `ro-billing`
- Table: `ro_billing_report`
- Sheet name: `RO Billing Report`
- Navigation: Service MIS -> Repair Billing -> R/O Billing Report
- Date fields: `#sBillDateFromDate`, `#sBillDateToDate`
- Normal range: current month start -> current date
- Historical backfill flag: `RO_BILLING_BACKFILL_ENABLED`

### PSF Yearly

- Report id: `psf-yearly`
- Table: `psf_yearly`
- Sheet name: `PSF Yearly`
- Navigation: Service MIS -> Customer Followup / Report -> Post Service Follow Up Report
- Date fields: `#sRODateFromDate`, `#sRODateToDate`
- Range: split into 30-day chunks because DMS rejects larger windows
- Uses grouped-header parsing.

### EW Report

- Report id: `ew-report`
- Table: `ew_report`
- Sheet name: `EW Report`
- Navigation: Service MIS -> Ext. Warranty -> Extended Warranty Report
- Date fields: `#sRegDateFromDate`, `#sRegDateToDate`
- Range: current month start -> current date

### MCP Report

- Report id: `mcp-report`
- Table: `mcp_report`
- Sheet name: `MCP Report`
- Navigation: Service -> My Convenience -> My Convenience List
- Date fields: `#sFromRegDate`, `#sToRegDate`
- Range: current month start -> current date

### Adv. wise lubricants & VAS

- Report id: `adv-wise-lubricants-vas`
- Table: `adv_wise_lubricants_vas`
- Sheet name: `Adv. wise lubricants & VAS`
- Navigation: Service MIS -> Work Profit -> Operation Wise Analysis Report
- Date type: `Billing Date`
- Date fields: `#startDate`, `#endDate`
- Range: current month start -> current date

### Operation Wise Analysis Report

- Report id: `operation-wise-analysis-report`
- Table: `operation_wise_analysis_report`
- Sheet name: `Operation Wise Analysis Report`
- Navigation: Service MIS -> Work Profit -> Operation Wise Analysis Report
- Report types: `Operation` and `Part`
- Both report types save into the same table.
- Additional columns:
  - `report_type`
  - `report_month`
  - `report_period_start`
  - `report_period_end`
- Normal range: current month start -> current date
- Historical backfill was tested and then disabled.

### Operation Wise Analysis Advisor Report

- Report id: `operation-wise-analysis-advisor-report`
- Table: `operation_wise_analysis_advisor_report`
- Sheet name: `Operation Wise Analysis Advisor Report`
- Navigation: Service MIS -> Work Profit -> Operation Wise Analysis Report
- Report Type: `Operation`
- Date Type: `Billing Date`
- Service Advisor dropdown: `#advEmpNo`
- Date fields: `#startDate`, `#endDate`
- Range: current month start -> current date
- Flow: loop through every non-empty Service Advisor option, search, select 300 rows, export every page, merge page exports, and save to the advisor table.
- Additional columns:
  - `report_type`
  - `date_type`
  - `service_advisor`
  - `report_month`
  - `report_period_start`
  - `report_period_end`
- This is separate from `operation_wise_analysis_report` so advisor-wise Operation data can be analyzed independently without disturbing the existing Operation/Part table.
- Historical backfill was completed on 2026-05-29. A resumed run inserted 288 rows after Windows sleep interrupted an earlier attempt.
- Long manual runs on Windows can use `npm run reports:awake`, which calls `scripts/run-awake.ps1` to keep the system/display awake while the report command is running.

### RSA Report

- Report id: `rsa-report`
- Table: `rsa_report`
- Sheet name: `RSA Report`
- Portal: `https://kia.awpassistance.in/report`
- Does not require KIA DMS login or OTP.
- Handles concurrent session popup.
- Has manual captcha pause if Google captcha appears.
- Uses RSA credentials from `.env`.

### Open RO Yearly

- Report id: `open-ro-yearly`
- Table: `open_ro_yearly`
- Sheet name: `Open RO Yearly`
- Navigation: Service MIS -> Repair Order -> Repair Order List
- Status filter: Open
- Date fields: `#sRoDateFromDate`, `#sRoDateToDate`
- Runs once daily at 6 PM.
- Range: March 2025 -> current date, split into 30-day chunks.

### Kia Call Center Complaints

- Report id: `kia-call-center-complaints`
- Table: `kia_call_center_complaints`
- Sheet name: `Kia call center complaints`
- Navigation: CRM -> Complaint -> KIN Call Center Complaint List
- Business Type: Service
- Date fields: `#sCompStartDate`, `#sCompEndDate`
- Runs once daily at 6 PM.
- Normal range: last 3 months -> current date.
- The DMS Excel export can omit real headers. The report always applies forced complaint headers before parsing so row values do not become SQL column names.

## 7. Database Architecture

The project originally stored one row per report/sheet in:

```text
business_excellence_am_kia_new
```

That old JSON table is now optional backup/debug storage.

The active architecture saves into dedicated relational tables:

```text
ro_billing_report
open_ro_yearly
ew_report
mcp_report
rsa_report
psf_yearly
adv_wise_lubricants_vas
operation_wise_analysis_report
operation_wise_analysis_advisor_report
kia_call_center_complaints
```

Main relational save code:

- `src/supabase/relational-store.js`

Behavior:

- Table names are normalized from sheet names.
- Header names become lowercase snake_case SQL columns.
- Tables are auto-created when missing.
- Missing columns are auto-added.
- Important indexes are auto-created.
- Every table has:
  - `id`
  - `row_hash`
  - `uploaded_at`
- `row_hash` is unique and prevents duplicate rows.
- `row_hash` is based on the full normalized row values that are actually saved into SQL, excluding only system columns like `id`, `row_hash`, and `uploaded_at`.
- Do not reduce `row_hash` to one or two business identifiers. A row with the same bill/RO/invoice/complaint number but different column values should be treated as a different full-row record.
- Inserts are batched.
- Duplicate conflicts update existing rows instead of creating duplicates.

Data type rules:

- Date-looking headers become `DATE`.
- Numeric-looking headers become `NUMERIC`.
- Everything else becomes `TEXT`.

Frontend/dashboard note:

- Dashboard APIs should read from relational tables, not the old JSON backup table.
- Use business date columns like `bill_date`, `ro_date`, `complaint_date`, `report_month`, or `report_period_start`.
- Do not use `uploaded_at` as the report period.

Known warning:

If logs show:

```text
Supabase JSON backup table unavailable; relational save completed
```

that is not a cron failure. It means the old JSON backup table is missing, but the relational table save succeeded.

## 8. Excel Parsing

Parser file:

- `src/excel/parse-workbook.js`

It handles:

- Simple one-row headers
- Grouped Kendo headers
- Forced headers for edge cases
- Header normalization
- Merging multiple exported page files

This was important because some DMS exports contain grouped headers that originally produced bad names like `Column 3`, `Column 4`, etc. The parser now reconstructs proper headers where possible.

## 9. Pagination and Downloads

Shared helper:

- `src/reports/paged-export.js`

Policy:

- Select page size 300.
- Export every visible page.
- Merge all page exports.
- Save to Supabase.
- Delete local exports only after DB save succeeds.
- Keep files if upload fails for debugging.

Temporary files:

```text
downloads/report-chunks/
downloads/merged/
temp/
```

## 10. OTP Flow

OTP provider:

```env
OTP_PROVIDER=webhook
```

Local webhook server:

- `src/otp/webhook-server.js`

Webhook client:

- `src/otp/webhook-client.js`

ngrok wrapper:

- `src/otp/ngrok-tunnel.js`

KIA DMS login:

- `src/auth/login.js`

Normal behavior:

1. Playwright enters KIA credentials.
2. It clicks Send OTP.
3. Android SMS Forwarder receives SMS on phone.
4. SMS Forwarder posts SMS text to ngrok `/sms`.
5. Local webhook extracts OTP.
6. Login fills OTP and continues.

Manual OTP mode exists for testing but should not remain enabled in production.

## 11. Reliability and Recovery

Retry wrapper:

- `src/utils/execute-with-retry.js`

Network recovery:

- `src/utils/network.js`

Failure support:

- `src/utils/failure.js`
- `src/utils/notifier.js`

Behavior:

- Each report retries up to configured attempts.
- Retry delay is randomized.
- Screenshots are captured on failure when possible.
- Failure email is sent only after all retries fail.
- Scheduler continues with the next report even if one report fails.
- Wi-Fi drops are handled by network wait/retry logic.

## 12. Logs and Monitoring

Important files:

```text
logs/app.log
logs/pm2-out.log
logs/pm2-error.log
logs/pm2-otp-out.log
logs/pm2-otp-error.log
logs/pm2-ngrok-out.log
logs/pm2-ngrok-error.log
logs/health.json
logs/screenshots/
```

Useful checks:

```powershell
pm2 status
pm2 logs kia-cron-job --lines 100
Get-Content logs\health.json
```

A successful run should show:

```text
failedReportCount: 0
status: success
```

When all imports succeed, the scheduler refreshes these dashboard materialized views before writing final success health:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY workshop_performance_jc_summary_v1;
REFRESH MATERIALIZED VIEW CONCURRENTLY workshop_operation_addon_summary_v1;
```

Implementation:

- `src/cron/scheduler.js` calls the refresh only when `failedReportCount` is `0`.
- `src/supabase/materialized-views.js` performs the refreshes through a standalone Postgres client.
- The refresh is skipped for failed import runs and dry-run runs.
- Each view logs start, success, and failure.
- A refresh failure is rethrown after logging, so PM2 captures the failed job.

## 13. Important Gotchas

- There are duplicate MIS sections in KIA DMS. Most service reports must use the Service MIS wrench icon, usually `li.nav_ser_mis`.
- DMS often rejects date ranges above 30 days. Chunk long ranges.
- Some date inputs clear themselves if start date is filled before end date. For those reports, fill end date first, then start date.
- Kendo dropdowns hide the real `<select>`. Do not rely only on `selectOption` against hidden elements.
- RSA portal may show captcha. The project pauses for manual solve; it does not bypass captcha.
- ngrok reserved URL can only be owned by one running ngrok process unless pooling is enabled.
- The old JSON backup table may not exist. That warning is harmless if relational save completed.
- Do not leave testing flags enabled after backfill.
- If duplicate rows are found in relational tables after hash logic changes, run `npm run dedupe:relational`.
- `dedupe:relational` removes exact duplicate rows based on all saved SQL column values except `id`, `row_hash`, and `uploaded_at`, then rebuilds `row_hash` so future cron upserts dedupe correctly.
- Duplicate checks that group by only invoice number, VIN, certificate, etc. can still show repeated business keys when other saved columns differ; use full-row checks to identify exact duplicate records.

## 14. How to Add a New Report

1. Add or extend navigation in `src/navigation/kia-menu.js`.
2. Create a report module in `src/reports/`.
3. Register it in `src/reports/index.js`.
4. Add config values in `src/config.js`.
5. Add `.env` values for testing.
6. Use `exportPagedGridToSupabase()` if it is a Kendo grid export.
7. Use relational storage as primary save path.
8. Make sure duplicates are prevented through stable row values.
9. Add report details to `PROJECT_CONTEXT.txt`.
10. Run `npm run check`.
11. Test with `TEST_SINGLE_REPORT=true`.
12. Restore production config after testing.

## 15. Takeover Checklist

Before handing over, the new developer should know how to:

- Start and stop PM2 processes.
- Check PM2 logs.
- Test the webhook health endpoint.
- Send a sample SMS payload to `/sms`.
- Run one selected report.
- Read `logs/health.json`.
- Find the relational table for each report.
- Understand duplicate prevention through `row_hash`.
- Know which reports run hourly and which run only at 6 PM.
- Restore `.env` after any testing mode.
- Update `PROJECT_CONTEXT.txt` whenever behavior changes.

## 16. Recommended KT Walkthrough

For live KT, walk through this order:

1. Show PM2 status and explain the three processes.
2. Open `.env` and explain only the non-secret config categories.
3. Open `src/cron/scheduler.js` and explain lanes plus lock.
4. Open `src/reports/index.js` and explain report registry.
5. Open one simple report, such as `ew-report.js`.
6. Open one complex report, such as `open-ro-yearly.js` or `operation-wise-analysis-report.js`.
7. Open `src/reports/paged-export.js`.
8. Open `src/excel/parse-workbook.js`.
9. Open `src/supabase/relational-store.js`.
10. Show Supabase relational tables and `row_hash`.
11. Show logs from the last successful PM2 run.
12. Explain common failure recovery.

## 17. Current Production Posture

As of the latest observed run, the regular cron lane completed successfully with zero failed reports. Logs showed relational saves completed and duplicate rows were detected correctly.

The project is operational, but the next owner should treat KIA DMS selector changes, network instability, OTP delivery, and RSA captcha as the main operational risks.

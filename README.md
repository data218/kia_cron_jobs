# KIA DMS OTP Automation

Node.js + Playwright automation for KIA DMS login with Telegram or Android HTTP webhook OTP retrieval, session persistence, retries, and cron scheduling.

## Structure

```text
src/
  auth/          KIA DMS login orchestration
  cron/          scheduled runner
  playwright/    browser/session/selectors
  excel/         in-memory workbook parsing
  supabase/      report row update/insert
  reports/       report-specific workflows
  telegram/      Telegram Bot API polling
  otp/           OTP provider adapter layer
  utils/         logging, retry, OTP parsing
```

## Quick Start

1. Install dependencies:

   ```powershell
   npm install
   npx playwright install chromium
   ```

2. Create or update `.env` using [.env.example](C:/Users/HP/Downloads/Kia_Cron_Job/.env.example).

3. Add:

   ```env
   KIA_USER_ID=EJK4020041
   KIA_PASSWORD=your-password
   OTP_PROVIDER=webhook
   SUPABASE_URL=your-supabase-url
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```

4. Test Telegram OTP polling:

   ```powershell
   npm run telegram:test
   ```

5. Test one login:

   ```powershell
   npm run login
   ```

6. Run login plus configured report downloads immediately:

   ```powershell
   npm run reports
   ```

7. Start scheduled mode:

   ```powershell
   npm run cron
   ```

## OTP Providers

Default:

```env
OTP_PROVIDER=telegram
```

Available fallback providers:

```env
OTP_PROVIDER=manual
OTP_PROVIDER=file
OTP_PROVIDER=webhook
```

Telegram OTP extraction uses:

```env
OTP_REGEX=\d{4,6}
```

The automation only accepts OTP messages received after the current `Send OTP` click, which avoids reusing an expired OTP from an earlier run.

## Android Webhook OTP

Use this when your Android SMS forwarding app asks for a Webhook URL.

```env
OTP_PROVIDER=webhook
OTP_WEBHOOK_BASE_URL=http://127.0.0.1:3333
OTP_WEBHOOK_TOKEN=choose-a-secret-token
OTP_WEBHOOK_HOST=0.0.0.0
OTP_WEBHOOK_PORT=3333
```

Start the receiver:

```powershell
npm run otp:webhook
```

Webhook route for the Android app:

```text
http://YOUR_PC_IP:3333/sms?token=choose-a-secret-token
```

If the phone is not on the same Wi-Fi, expose port `3333` with a tunnel and use:

```text
https://YOUR_TUNNEL_DOMAIN/sms?token=choose-a-secret-token
```

## Session Persistence

The browser session is saved to:

```text
storage/kia-dms-state.json
```

On the next run, Playwright loads this state first. If KIA DMS still accepts the session, OTP login is skipped. If the session has expired, the script performs a full login and requests a new OTP.

## Reports

The report pipeline logs in once and runs all configured reports sequentially in the same authenticated browser session.

Current report:

```text
MIS -> Repair Billing -> R/O Billing Report
CRM -> Complaint -> KIN Call Center Complaint List
```

RO Billing behavior:

- Uses `#sBillDateFromDate` and `#sBillDateToDate`
- Date range is one month before plus one day through today
- Clicks `#btnSearch`
- Waits for the Kendo grid to finish loading
- Selects Kendo pager size `300`
- Waits for the Kendo grid to refresh
- Exports Excel
- Parses the downloaded workbook in memory
- Updates or inserts one row in Supabase table `business_excellence_am_kia_new`
- Stores `headers` and `rows` as JSONB
- Uses `sheet_name = RO Billing Report March 25`

Kia Call Center Complaints behavior:

- Opens `CRM -> Complaint -> KIN Call Center Complaint List`
- Selects `Business Type = Service`
- Uses `#sCompStartDate` and `#sCompEndDate`
- Date range is exactly three months before today through today
- Clicks `#btnSearch`
- Waits for the Kendo grid to finish loading
- Selects Kendo pager size `300`
- Exports and parses the downloaded workbook in memory
- Updates or inserts one row using `sheet_name = Kia call center complaints`

No `.xlsx` report file is saved permanently in the project.

Supabase config:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_REPORTS_TABLE=business_excellence_am_kia_new
RO_BILLING_SHEET_NAME=RO Billing Report March 25
KIA_CALL_CENTER_COMPLAINTS_SHEET_NAME=Kia call center complaints
```

Run once:

```powershell
npm run reports
```

## Future Report Downloads

Add new reports to [src/reports/index.js](C:/Users/HP/Downloads/Kia_Cron_Job/src/reports/index.js). Each report receives the existing logged-in `page`, so future downloads do not need a new OTP/login.

For all manual setup steps, read [SETUP_GUIDE.txt](C:/Users/HP/Downloads/Kia_Cron_Job/SETUP_GUIDE.txt).

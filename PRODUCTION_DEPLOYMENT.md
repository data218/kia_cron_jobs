# KIA Cron Production Deployment

This project is a long-running Node.js automation system. It is designed for an Ubuntu VPS with PM2, Playwright Chromium, Supabase, structured logs, and failure email alerts.

Do not deploy this as a serverless function or edge function. Browser automation, downloads, Excel parsing, and long report exports need a persistent server process.

## Runtime Stack

- Node.js
- Playwright Chromium
- PM2
- Supabase
- ExcelJS
- node-cron
- dotenv
- Nodemailer
- Pino logger

## Server Setup

Install Node.js LTS and system dependencies:

```bash
sudo apt update
sudo apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Install project dependencies:

```bash
cd /opt/kia-cron-job
npm ci
npx playwright install chromium
npx playwright install-deps chromium
```

Install PM2:

```bash
sudo npm install -g pm2
pm2 -v
```

## Environment

Create the production `.env` file:

```bash
cp .env.example .env
nano .env
```

Required production settings:

```env
NODE_ENV=production
HEADLESS=true

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=

KIA_USER_ID=
KIA_PASSWORD=

RSA_USER_ID=
RSA_PASSWORD=

REPORTS_TO_RUN=all
TEST_SINGLE_REPORT=false
TEST_REPORT_NAME=

REGULAR_REPORTS_CRON_SCHEDULE=0 10-18 * * *
OPEN_RO_YEARLY_CRON_SCHEDULE=0 10,18 * * *

REPORT_MAX_RETRIES=3
REPORT_RETRY_DELAY_MIN_MS=30000
REPORT_RETRY_DELAY_MAX_MS=60000

LOGS_DIR=./logs
SCREENSHOTS_DIR=./logs/screenshots
DOWNLOAD_DIR=./downloads
REPORT_CHUNKS_DIR=./downloads/report-chunks
MERGED_DIR=./downloads/merged
TEMP_DIR=./temp

ALERT_EMAIL_FROM=
ALERT_EMAIL_TO=
ALERT_EMAIL_APP_PASSWORD=
```

For development of one report only:

```env
TEST_SINGLE_REPORT=true
TEST_REPORT_NAME=ew-report
```

To test scheduler sequencing safely without browser login, downloads, or Supabase writes:

```bash
npm run test:sequence
```

This dry-run command verifies:

- regular reports are selected without `Open RO Yearly`
- reports execute one after another
- `Open RO Yearly` runs in its own lane
- overlapping scheduler ticks are skipped by the execution lock

## PM2

Start the scheduler:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

The `pm2 startup` command prints one extra command with `sudo`. Run that generated command, then run:

```bash
pm2 save
```

Useful PM2 commands:

```bash
pm2 status
pm2 logs kia-cron-job
pm2 reload kia-cron-job
pm2 restart kia-cron-job
pm2 monit
```

## Logs And Health

Application logs:

```text
logs/app.log
```

PM2 logs:

```text
logs/pm2-out.log
logs/pm2-error.log
```

Failure screenshots:

```text
logs/screenshots/
```

Health heartbeat:

```text
logs/health.json
```

The health file tracks:

- current status
- start time
- completion time
- duration
- report results
- last fatal scheduler error

## Scheduler Design

There is one master scheduler:

```text
src/cron/scheduler.js
```

It runs selected reports sequentially in one process. Reports do not run concurrently because the portals share browser sessions, downloads, and fragile UI state.

Report order is defined in:

```text
src/reports/index.js
```

Production should normally use:

```env
REPORTS_TO_RUN=all
TEST_SINGLE_REPORT=false
```

Schedules:

```env
REGULAR_REPORTS_CRON_SCHEDULE=0 10-18 * * *
OPEN_RO_YEARLY_CRON_SCHEDULE=0 10,18 * * *
```

Regular reports run hourly from 10 AM through 6 PM. `Open RO Yearly` is excluded from the regular hourly lane and runs only at 10 AM and 6 PM because it is a large yearly export.

The scheduler uses one in-process execution lock. If a previous run is still active when another schedule ticks, the new run is skipped to prevent overlapping Playwright/download/export work.

## Retry And Failure Handling

Each report is wrapped by:

```text
src/utils/execute-with-retry.js
```

Behavior:

- retry each report up to `REPORT_MAX_RETRIES`
- wait 30 to 60 seconds between retries by default
- capture a screenshot after each failure
- send one failure email only after all retries fail
- continue to the next report after a report fails completely

Failure email helper:

```text
src/utils/notifier.js
```

Email includes:

- report name
- retry count
- timestamp
- stack trace
- current URL
- server hostname
- environment
- duration
- screenshot path and attachment when available

## Downloads And Temp Files

Reports export temporary files under:

```text
downloads/report-chunks/
```

Successful uploads delete their temporary export folder automatically.

The `temp/` folder is cleaned at each master job start.

## Supabase Storage

The existing table remains the source of truth:

```text
public.business_excellence_am_kia_new
```

Storage model:

- one row per dataset
- `brand = kia`
- `sheet_name`
- `headers` as JSONB
- `rows` as JSONB
- `uploaded_at`

Existing rows are preserved. New uploads append only rows not already present.

Large existing sheets use direct PostgreSQL JSONB append through `DATABASE_URL` to avoid Supabase REST timeouts from resending huge historical JSON arrays.

## Adding A New Report

1. Add navigation in `src/navigation/kia-menu.js`.
2. Add report module in `src/reports/`.
3. Register it in `src/reports/index.js`.
4. Add any config in `src/config.js` and `.env`.
5. Use shared pagination/export helper where possible:

```text
src/reports/paged-export.js
```

6. Store through:

```text
src/supabase/report-store.js
```

7. Run:

```bash
npm run check
npm run reports
```

8. Update `PROJECT_CONTEXT.txt`.



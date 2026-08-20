module.exports = {
  apps: [
    {
      name: 'kia-worker',
      script: './apps/kia/runner/worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './apps/kia/runtime/pm2-out.log',
      error_file: './apps/kia/runtime/pm2-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'kia-worker',
        KIA_WORKER_ENABLED: 'true'
      }
    },
    {
      name: 'platinum-worker',
      script: './apps/platinum/runner/worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './apps/platinum/runtime/pm2-out.log',
      error_file: './apps/platinum/runtime/pm2-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'platinum-worker',
        PLATINUM_WORKER_ENABLED: 'false'
      }
    },
    {
      name: 'hmil-worker',
      script: './apps/hmil/runner/worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './apps/hmil/runtime/pm2-out.log',
      error_file: './apps/hmil/runtime/pm2-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'hmil-worker',
        HMIL_WORKER_ENABLED: 'false'
      }
    },
    {
      name: 'hmil-cron-job',
      script: './src/cron/hmil-scheduler.js',
      args: '--scheduler',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-hmil-out.log',
      error_file: './logs/pm2-hmil-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'hmil-cron-job'
      }
    },
    {
      name: 'hmil-historical-backfill',
      script: './scripts/run-hmil-historical-backfill.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      stop_exit_codes: [0],
      restart_delay: 30000,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-hmil-historical-out.log',
      error_file: './logs/pm2-hmil-historical-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'hmil-historical-backfill',
        HMIL_HISTORICAL_START_DATE: '2021-01-01',
        HMIL_HISTORICAL_END_DATE: '2026-06-16',
        HMIL_HISTORICAL_REPORTS: 'hyundai-repair-order-list,hyundai-ro-billing-report,hyundai-operation-wise-analysis-report',
        HMIL_HISTORICAL_DEALERS: 'N5203,N5701,N5804,N5806,N6815,N6819,N6826',
        HMIL_HISTORICAL_FORCE_LOGIN: 'false',
        HMIL_HISTORICAL_HEADLESS: 'false',
        HMIL_HISTORICAL_OTP_PROVIDER: 'webhook',
        HMIL_HISTORICAL_STOP_ON_FAILURE: 'false',
        HMIL_HISTORICAL_RESUME_FROM_STATE: 'true'
      }
    },
    {
      name: 'hmil-ro-billing-2008-2020-once',
      script: './scripts/run-hmil-ro-billing-2008-2020-once.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      stop_exit_codes: [0],
      restart_delay: 30000,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-hmil-ro-billing-2008-2020-out.log',
      error_file: './logs/pm2-hmil-ro-billing-2008-2020-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'hmil-ro-billing-2008-2020',
        HMIL_RO_BILLING_2008_2020_HISTORICAL_START_DATE: '2008-01-01',
        HMIL_RO_BILLING_2008_2020_HISTORICAL_END_DATE: '2020-12-31',
        HMIL_RO_BILLING_2008_2020_HISTORICAL_REPORTS: 'hyundai-ro-billing-report',
        HMIL_RO_BILLING_2008_2020_HISTORICAL_OTP_PROVIDER: 'webhook',
        HMIL_RO_BILLING_2008_2020_HISTORICAL_RESUME_FROM_STATE: 'true',
        HMIL_RO_BILLING_2008_2020_HISTORICAL_STOP_ON_FAILURE: 'false',
        HMIL_RO_BILLING_2008_2020_HISTORICAL_SKIP_EXISTING: 'false',
        HMIL_RO_BILLING_2008_2020_HISTORICAL_HEADLESS: 'false'
      }
    },
    {
      name: 'am-platinum-cron-job',
      script: './src/cron/am-platinum-scheduler.js',
      args: '--scheduler',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-am-platinum-out.log',
      error_file: './logs/pm2-am-platinum-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'am-platinum-cron-job',
        OTP_PROVIDER: 'webhook',
        AM_PLATINUM_CRON_SCHEDULE: '0 10,16 * * *',
        AM_PLATINUM_CRON_TIMEZONE: 'Asia/Kolkata',
        AM_PLATINUM_CURRENT_MONTH_ONLY: 'true',
        GDMS_OTP_LOCK_ENABLED: 'true',
        AM_PLATINUM_SKIP_PHASE1: 'false'
      }
    },
    // Operation-wise is NOT a separate PM2 app — it runs inside am-platinum-historical-pipeline
    // (one browser/login at a time). Do not pm2 start this alongside the pipeline.
    // {
    //   name: 'am-platinum-operation-wise-historical',
    //   script: './scripts/recover-am-platinum-operation-wise.js',
    //   ...
    // },
    {
      name: 'am-platinum-historical-pipeline',
      script: './scripts/run-am-platinum-historical-pipeline.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-am-platinum-pipeline-out.log',
      error_file: './logs/pm2-am-platinum-pipeline-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'am-platinum-historical-pipeline',
        AM_PLATINUM_HISTORICAL_HEADLESS: 'false'
      }
    },
    {
      name: 'am-platinum-historical-backfill',
      script: './scripts/run-am-platinum-historical-backfill.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      stop_exit_codes: [0],
      restart_delay: 30000,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-am-platinum-historical-out.log',
      error_file: './logs/pm2-am-platinum-historical-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'am-platinum-historical-backfill',
        AM_PLATINUM_HISTORICAL_START_DATE: '2021-01-01',
        AM_PLATINUM_HISTORICAL_END_DATE: '2026-06-09',
        AM_PLATINUM_HISTORICAL_REPORTS: 'hyundai-repair-order-list,hyundai-ro-billing-report,hyundai-call-center-complaints,hyundai-demo-car-list,hyundai-service-appointment,hyundai-trust-package-bodyshop-sot,hyundai-trust-package-sot-super,hyundai-trust-package-package-list,hyundai-psf-yearly,hyundai-ew-report,hyundai-adv-wise-lubricants-vas,hyundai-operation-wise-analysis-report',
        AM_PLATINUM_HISTORICAL_DEALERS: 'N5211,N6824,N6828',
        AM_PLATINUM_HISTORICAL_FORCE_LOGIN: 'false',
        AM_PLATINUM_HISTORICAL_HEADLESS: 'false',
        AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE: 'true',
        AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE: 'true',
        AM_PLATINUM_HISTORICAL_SKIP_EXISTING: 'false'
      }
    },
    {
      name: 'hmil-warranty-cron-job',
      script: './src/cron/hmil-warranty-scheduler.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-hmil-warranty-out.log',
      error_file: './logs/pm2-hmil-warranty-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'hmil-warranty-cron-job',
        OTP_PROVIDER: 'webhook',
        HMIL_WARRANTY_HISTORICAL_START_DATE: '2025-01-01',
        HMIL_WARRANTY_CRON_TIMEZONE: 'Asia/Kolkata',
        HMIL_WARRANTY_SCHEDULED_RESUME: 'true',
        HMIL_WARRANTY_FORCE_LOGIN: 'false',
        GDMS_OTP_LOCK_ENABLED: 'true'
      }
    },
    {
      name: 'kia-rsa-cron-job',
      script: './src/cron/kia-rsa-scheduler.js',
      args: '--scheduler',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-kia-rsa-out.log',
      error_file: './logs/pm2-kia-rsa-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'kia-rsa-cron-job',
        HEADLESS: 'false',
        RSA_HEADLESS: 'false'
      }
    },
    {
      name: 'kia-cron-scheduler',
      script: './src/cron/scheduler.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-kia-cron-scheduler-out.log',
      error_file: './logs/pm2-kia-cron-scheduler-error.log',
      env: {
        NODE_ENV: 'production',
        LOG_SERVICE_NAME: 'kia-cron-scheduler'
      }
    },
    {
      name: 'kia-otp-webhook',
      script: './src/otp/webhook-server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-otp-out.log',
      error_file: './logs/pm2-otp-error.log',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'kia-ngrok',
      script: './src/otp/ngrok-tunnel.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-ngrok-out.log',
      error_file: './logs/pm2-ngrok-error.log',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'kia-safety-daily',
      script: './src/cron/kia-safety-scheduler.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      watch: false,
      cron_restart: '0 10 * * *',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-kia-safety-out.log',
      error_file: './logs/pm2-kia-safety-error.log',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'restart-db',
      script: './scripts/restart-db.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      watch: false,
      out_file: './logs/pm2-restart-db-out.log',
      error_file: './logs/pm2-restart-db-error.log',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'clean-memory',
      script: './scripts/clean-memory.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '0 22 * * *',
      watch: false,
      out_file: './logs/pm2-clean-memory-out.log',
      error_file: './logs/pm2-clean-memory-error.log',
      env: {
        NODE_ENV: 'production'
      }
    },
    // AM Platinum Sales Report -> am_platinum_sales_report, daily at 19:10.
    //
    // Window fixed at 2025-01-01 -> today; chunks already uploaded are skipped via their
    // .saved.json markers, so each night only re-exports the trailing chunk.
    //
    // 19:10 keeps it clear of am-platinum-cron-job (10:00/16:00), which drives the SAME
    // AM Platinum login — the active dealer is server-side session state, so two dealer-
    // switching automations must never overlap.
    {
      name: 'platinum-sales-report',
      script: './scripts/run-platinum-sales-report.js',
      args: '--start=2025-01-01 --headless',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '10 19 * * *',
      watch: false,
      out_file: './logs/pm2-platinum-sales-report-out.log',
      error_file: './logs/pm2-platinum-sales-report-error.log',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Kolkata'
      }
    },
    // Interakt social-media leads, every 10 minutes across the working day.
    //
    // Standard cron cannot express "every 10 min from 09:00 to 18:30" in one expression, so
    // this is split: 09:00-17:50 on the ten-minute mark, plus the 18:00-18:30 tail.
    //
    // Headless is safe ONLY because the session state is reused; a fresh login needs the
    // WhatsApp OTP typed in, which requires one visible run first:
    //   node scripts/run-interakt-leads-once.js
    {
      name: 'interakt-leads',
      script: './scripts/run-interakt-leads-once.js',
      args: '--headless',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '*/10 9-17 * * *',
      watch: false,
      out_file: './logs/pm2-interakt-leads-out.log',
      error_file: './logs/pm2-interakt-leads-error.log',
      env: { NODE_ENV: 'production', TZ: 'Asia/Kolkata' }
    },
    {
      name: 'interakt-leads-evening',
      script: './scripts/run-interakt-leads-once.js',
      args: '--headless',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '0,10,20,30 18 * * *',
      watch: false,
      out_file: './logs/pm2-interakt-leads-out.log',
      error_file: './logs/pm2-interakt-leads-error.log',
      env: { NODE_ENV: 'production', TZ: 'Asia/Kolkata' }
    },
    // Booking Report (MIS > Booking Reports > Booking Report), daily at 17:20.
    //
    // Covers BOTH GDMS logins sequentially and every dealer under each:
    //   hmil-booking (AMMIS) -> hyundai_booking_report
    //   am-platinum    -> am_platinum_booking_report
    //
    // Scheduled before the 18:10 HIIB jobs and clear of hmil-cron-job (12:00/15:45/20:00),
    // because it drives the same HMIL login and the active dealer is server-side state —
    // two automations switching dealers at once would cross-contaminate each other.
    {
      name: 'hyundai-booking-report',
      script: './scripts/run-hyundai-booking-report.js',
      args: '--headless',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '20 17 * * *',
      watch: false,
      out_file: './logs/pm2-hyundai-booking-report-out.log',
      error_file: './logs/pm2-hyundai-booking-report-error.log',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Kolkata'
      }
    },
    // HIIB insurance portal (ha.hiib.in), daily at 18:10 local time.
    //
    // One-shot scripts, not long-lived schedulers: autorestart:false + cron_restart is the
    // same pattern as clean-memory above. PM2 launches them once when the ecosystem file is
    // started, then again on each cron tick.
    //
    // The two accounts are safe to run at the same minute — createHiibAccountProfile gives
    // each its own session state, download dir and chunk dir.
    //
    // --days=90 keeps the nightly run to a rolling window. Without it the script defaults to
    // HYUNDAI_INSURANCE_REPORT_BACKFILL_START_DATE (2024-04-01) and would re-scrape the
    // entire backfill every night. Full history is loaded by running the script by hand.
    {
      name: 'hiib-insurance-hyundai',
      script: './scripts/run-hyundai-insurance-report-once.js',
      args: '--account=hiib --days=90 --headless',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '10 18 * * *',
      watch: false,
      out_file: './logs/pm2-hiib-insurance-hyundai-out.log',
      error_file: './logs/pm2-hiib-insurance-hyundai-error.log',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Kolkata'
      }
    },
    {
      name: 'hiib-insurance-platinum',
      script: './scripts/run-hyundai-insurance-report-once.js',
      args: '--account=platinum --days=90 --headless',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '10 18 * * *',
      watch: false,
      out_file: './logs/pm2-hiib-insurance-platinum-out.log',
      error_file: './logs/pm2-hiib-insurance-platinum-error.log',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Kolkata'
      }
    }
  ]
};

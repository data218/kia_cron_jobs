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
        HMIL_HISTORICAL_DEALERS: 'N5203,N5701,N5804,N5806,N5D00,N6815,N6819,N6826',
        HMIL_HISTORICAL_FORCE_LOGIN: 'false',
        HMIL_HISTORICAL_HEADLESS: 'false',
        HMIL_HISTORICAL_OTP_PROVIDER: 'webhook',
        HMIL_HISTORICAL_STOP_ON_FAILURE: 'false',
        HMIL_HISTORICAL_RESUME_FROM_STATE: 'true'
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
        AM_PLATINUM_CRON_SCHEDULE: '10 16 * * *',
        AM_PLATINUM_CRON_TIMEZONE: 'Asia/Kolkata',
        AM_PLATINUM_CURRENT_MONTH_ONLY: 'true',
        GDMS_OTP_LOCK_ENABLED: 'true'
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
        HMIL_WARRANTY_CRON_SCHEDULE: '10 15 * * *',
        HMIL_WARRANTY_CRON_TIMEZONE: 'Asia/Kolkata',
        HMIL_WARRANTY_SCHEDULED_RESUME: 'true',
        HMIL_WARRANTY_FORCE_LOGIN: 'true',
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
    }
  ]
};

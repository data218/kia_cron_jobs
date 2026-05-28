module.exports = {
  apps: [
    {
      name: 'kia-cron-job',
      script: './src/cron/scheduler.js',
      args: '--scheduler',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      env: {
        NODE_ENV: 'production'
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

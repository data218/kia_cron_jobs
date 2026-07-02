import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

function machineScopedEnv(name, fallback = '') {
  const suffixes = [process.env.COMPUTERNAME, process.env.USERNAME]
    .map(value => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '_'))
    .filter(Boolean);

  for (const suffix of suffixes) {
    const value = process.env[`${name}_${suffix}`];
    if (value != null && value !== '') return value;
  }

  return process.env[name] ?? fallback;
}

let ngrokPath = machineScopedEnv('NGROK_EXE_PATH', 'ngrok');
const publicUrl = machineScopedEnv('OTP_PUBLIC_WEBHOOK_URL');
const port = machineScopedEnv('OTP_WEBHOOK_PORT', '3333');

if (!publicUrl) {
  throw new Error('OTP_PUBLIC_WEBHOOK_URL is required to start the ngrok tunnel');
}

if (ngrokPath !== 'ngrok' && !fs.existsSync(ngrokPath)) {
  console.warn(`NGROK_EXE_PATH does not exist: ${ngrokPath}; falling back to ngrok from PATH.`);
  ngrokPath = 'ngrok';
}

function startTunnel(useReservedUrl = true) {
  const args = ['http', port, '--log', 'stdout', '--log-format', 'logfmt'];
  if (useReservedUrl && publicUrl) {
    const domain = publicUrl.replace(/^https?:\/\//, '').split('/')[0];
    args.push('--domain', domain);
  }

  const child = spawn(ngrokPath, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stderr = '';
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk));

  child.on('exit', (code, signal) => {
    if (code !== 0 && useReservedUrl && /ERR_NGROK_334|ERR_NGROK_320|already online|reserved/i.test(stderr)) {
      console.warn('Reserved ngrok URL is unavailable (already in use or reserved for another account); starting dynamic tunnel instead.');
      startTunnel(false);
      return;
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

startTunnel(true);


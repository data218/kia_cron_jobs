import 'dotenv/config';
import express from 'express';
import { config } from '../config.js';
import { extractOtp, isOtp } from '../utils/otp.js';
import { logger } from '../utils/logger.js';

const app = express();
let latestOtp = null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ['text/*', 'application/xml'] }));

app.use((req, _res, next) => {
  if (config.otpWebhookDebug) {
    logger.info('Webhook request received', {
      method: req.method,
      path: req.path,
      query: req.query,
      contentType: req.headers['content-type'],
      bodyType: typeof req.body,
      body: typeof req.body === 'string' ? req.body.slice(0, 300) : req.body
    });
  }
  next();
});

function authorize(req, res, next) {
  const expected = `Bearer ${config.otpWebhookToken}`;
  const token = req.headers.authorization === expected ||
    req.headers['x-webhook-token'] === config.otpWebhookToken ||
    req.query.token === config.otpWebhookToken ||
    req.body?.token === config.otpWebhookToken;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function saveOtp(otp, source) {
  latestOtp = {
    otp,
    source,
    receivedAt: new Date().toISOString()
  };

  logger.info('Webhook OTP received', {
    source,
    receivedAt: latestOtp.receivedAt
  });

  return latestOtp;
}

function payloadText(req) {
  if (typeof req.body === 'string') return req.body;

  const body = req.body ?? {};
  const query = req.query ?? {};
  return [
    query.otp,
    query.text,
    query.message,
    query.sms,
    query.body,
    query.content,
    query.msg,
    body.otp,
    body.text,
    body.message,
    body.sms,
    body.body,
    body.content,
    body.msg,
    body.data,
    JSON.stringify(body)
  ].filter(Boolean).join('\n');
}

app.get('/health', (_req, res) => {
  return res.json({ ok: true, service: 'kia-dms-otp-webhook' });
});

app.get('/', (_req, res) => {
  return res.json({
    ok: true,
    service: 'kia-dms-otp-webhook',
    routes: {
      sms: '/sms?token=YOUR_TOKEN',
      latest: '/otp/latest'
    }
  });
});

app.post('/otp', authorize, (req, res) => {
  const otp = String(req.body?.otp ?? '').trim();
  if (!isOtp(otp)) {
    return res.status(400).json({ error: 'OTP must be 4 to 8 digits' });
  }

  const saved = saveOtp(otp, 'direct-otp');
  return res.json({ ok: true, otp, receivedAt: saved.receivedAt });
});

function receiveSms(req, res) {
  const text = payloadText(req);
  const otp = extractOtp(text, config.otpRegex);

  if (!otp) {
    logger.warn('Webhook SMS received but no OTP matched regex', {
      preview: text.slice(0, 160)
    });
    return res.status(400).json({
      error: 'No OTP found in SMS payload',
      expectedRegex: config.otpRegex.source
    });
  }

  const saved = saveOtp(otp, 'sms-forwarder');
  return res.json({ ok: true, otp, receivedAt: saved.receivedAt });
}

app.get(['/sms', '/sms-forwarder', '/android-sms'], authorize, receiveSms);
app.post(['/sms', '/sms-forwarder', '/android-sms'], authorize, receiveSms);

app.get('/debug-sms', receiveSms);
app.post('/debug-sms', receiveSms);

app.get('/otp/latest', authorize, (_req, res) => {
  if (!latestOtp) {
    return res.status(404).json({ error: 'No OTP received yet' });
  }

  return res.json(latestOtp);
});

app.listen(config.otpWebhookPort, config.otpWebhookHost, () => {
  logger.info(`OTP webhook server listening on http://${config.otpWebhookHost}:${config.otpWebhookPort}`);
  logger.info('Android SMS forwarder POST route', {
    path: `/sms?token=${config.otpWebhookToken}`
  });
});

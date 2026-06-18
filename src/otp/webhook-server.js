import 'dotenv/config';
import express from 'express';
import { config } from '../config.js';
import { extractOtp, isOtp } from '../utils/otp.js';
import { logger } from '../utils/logger.js';

const app = express();
let latestOtp = null;
let recentOtps = [];

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

function detectOtpPurpose(text, otp) {
  const value = String(text ?? '').toLowerCase();
  if (/\b(?:hyundai|gdms)\b|mobile\s+number\s+authentication/.test(value)) {
    return 'hmil';
  }

  if (/\bkia\b|kia\s+dms/.test(value)) {
    return 'kia';
  }

  if (/^\d{5}$/.test(String(otp ?? ''))) {
    return 'kia';
  }

  return 'unknown';
}

function saveOtp(otp, source, { purpose = 'unknown' } = {}) {
  latestOtp = {
    otp,
    source,
    purpose,
    receivedAt: new Date().toISOString()
  };
  recentOtps = [latestOtp, ...recentOtps].slice(0, 30);

  logger.info('Webhook OTP received', {
    source,
    purpose,
    receivedAt: latestOtp.receivedAt
  });

  return latestOtp;
}

function flattenPayloadValues(value, output = []) {
  if (value == null) return output;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach(item => flattenPayloadValues(item, output));
    return output;
  }

  if (typeof value === 'object') {
    for (const [key, nestedValue] of Object.entries(value)) {
      output.push(String(key));
      flattenPayloadValues(nestedValue, output);
    }
  }

  return output;
}

function payloadText(req) {
  if (typeof req.body === 'string') return req.body;

  const body = req.body ?? {};
  const query = req.query ?? {};
  const knownFields = [
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
  ];

  return [
    ...knownFields,
    ...flattenPayloadValues(query),
    ...flattenPayloadValues(body)
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

  const purpose = String(req.body?.purpose ?? req.query?.purpose ?? 'unknown').trim().toLowerCase();
  const saved = saveOtp(otp, 'direct-otp', { purpose });
  return res.json({ ok: true, otp, purpose: saved.purpose, receivedAt: saved.receivedAt });
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

  const purpose = detectOtpPurpose(text, otp);
  const saved = saveOtp(otp, 'sms-forwarder', { purpose });
  return res.json({ ok: true, otp, purpose: saved.purpose, receivedAt: saved.receivedAt });
}

app.get(['/sms', '/sms-forwarder', '/android-sms'], authorize, receiveSms);
app.post(['/sms', '/sms-forwarder', '/android-sms'], authorize, receiveSms);

app.get('/debug-sms', receiveSms);
app.post('/debug-sms', receiveSms);

app.get('/otp/latest', authorize, (req, res) => {
  const purpose = String(req.query.purpose ?? '').trim().toLowerCase();
  const selectedOtp = purpose
    ? recentOtps.find(candidate => candidate.purpose === purpose)
    : latestOtp;

  if (!selectedOtp && purpose === 'kia') {
    return res.status(404).json({ error: 'No Kia OTP received yet' });
  }

  if (!selectedOtp && purpose === 'hmil') {
    return res.status(404).json({ error: 'No GDMS/Hyundai OTP received yet' });
  }

  if (!selectedOtp) {
    return res.status(404).json({ error: 'No OTP received yet' });
  }

  return res.json(selectedOtp);
});

app.listen(config.otpWebhookPort, config.otpWebhookHost, () => {
  logger.info(`OTP webhook server listening on http://${config.otpWebhookHost}:${config.otpWebhookPort}`);
  logger.info('Android SMS forwarder POST route', {
    path: '/sms?token=<redacted>'
  });
});

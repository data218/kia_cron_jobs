import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { config } from '../config.js';

fs.mkdirSync(config.logsDir, { recursive: true });

function normalizeMeta(meta) {
  if (!meta) return undefined;

  if (meta instanceof Error) {
    return {
      err: {
        name: meta.name,
        message: meta.message,
        stack: meta.stack
      }
    };
  }

  return meta;
}

const streams = [
  { stream: process.stdout },
  {
    stream: pino.destination({
      dest: path.join(config.logsDir, 'app.log'),
      mkdir: true,
      sync: false
    })
  }
];

const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'kia-cron-job',
    env: process.env.NODE_ENV || 'development'
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err
  }
}, pino.multistream(streams));

function write(level, message, meta) {
  const normalized = normalizeMeta(meta);
  if (normalized) {
    baseLogger[level](normalized, message);
    return;
  }

  baseLogger[level](message);
}

export const logger = {
  child(bindings) {
    return baseLogger.child(bindings);
  },
  info(message, meta) {
    write('info', message, meta);
  },
  warn(message, meta) {
    write('warn', message, meta);
  },
  error(message, meta) {
    write('error', message, meta);
  }
};

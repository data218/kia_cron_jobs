import fs from 'node:fs/promises';
import os from 'node:os';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from './logger.js';

function emailConfigured() {
  return Boolean(
    config.alertEmailFrom &&
    config.alertEmailTo &&
    config.alertEmailAppPassword
  );
}

function errorText(error) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function stackText(error) {
  return error instanceof Error ? error.stack : '';
}

async function fileExists(filePath) {
  if (!filePath) return false;
  return fs.access(filePath).then(() => true).catch(() => false);
}

export async function sendFailureEmail({
  reportName,
  error,
  retriesAttempted,
  startedAt,
  finishedAt = new Date(),
  screenshotPath,
  currentUrl,
  exportStatus = 'unknown'
}) {
  if (!emailConfigured()) {
    logger.warn('Failure email skipped because alert email env vars are not configured', {
      reportName
    });
    return { sent: false, reason: 'email_not_configured' };
  }

  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const subject = `[KIA CRON FAILURE] ${reportName} failed after ${retriesAttempted} retries`;
  const body = [
    `Cron Name: ${reportName}`,
    '',
    'Status: FAILED',
    '',
    `Retries Attempted: ${retriesAttempted}`,
    '',
    `Timestamp: ${finishedAt.toISOString()}`,
    '',
    `Execution Duration: ${durationMs} ms`,
    '',
    `Error: ${errorText(error)}`,
    '',
    `Current URL: ${currentUrl || 'unknown'}`,
    '',
    `Export/Download Status: ${exportStatus}`,
    '',
    `Screenshot Path: ${screenshotPath || 'not captured'}`,
    '',
    `Server: ${os.hostname()}`,
    '',
    `Environment: ${process.env.NODE_ENV || 'development'}`,
    '',
    'Stack Trace:',
    stackText(error)
  ].join('\n');

  const attachments = [];
  if (await fileExists(screenshotPath)) {
    attachments.push({
      filename: screenshotPath.split(/[\\/]/).pop(),
      path: screenshotPath
    });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: config.alertEmailFrom,
      pass: config.alertEmailAppPassword
    }
  });

  await transporter.sendMail({
    from: config.alertEmailFrom,
    to: config.alertEmailTo,
    subject,
    text: body,
    attachments
  });

  logger.info('Failure email sent', {
    reportName,
    to: config.alertEmailTo,
    screenshotAttached: attachments.length > 0
  });

  return { sent: true };
}

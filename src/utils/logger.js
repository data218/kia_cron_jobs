function line(level, message, meta) {
  const timestamp = new Date().toISOString();
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[${timestamp}] [${level}] ${message}${suffix}`);
}

export const logger = {
  info(message, meta) {
    line('INFO', message, meta);
  },
  warn(message, meta) {
    line('WARN', message, meta);
  },
  error(message, error) {
    const meta = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error;
    line('ERROR', message, meta);
  }
};

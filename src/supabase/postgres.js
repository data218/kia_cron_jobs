import pg from 'pg';
import { config, requireSecret } from '../config.js';

const { Client } = pg;

function quoteIdentifier(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new Error(`Unsafe SQL identifier: ${text}`);
  }

  return `"${text}"`;
}

export { quoteIdentifier };

export async function withPostgresClient(fn) {
  requireSecret('DATABASE_URL', config.databaseUrl);

  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: {
      rejectUnauthorized: false
    },
    // The socket sits idle for the whole of a long scrape before the first query, and the
    // server/pooler drops it. Keepalives hold it open; the timeouts stop a wedged query
    // from hanging a cron forever.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    connectionTimeoutMillis: 30000,
    statement_timeout: 300000,
    query_timeout: 300000
  });

  // pg emits 'error' on the Client when the connection drops. Node treats an unhandled
  // 'error' event as fatal, so without this listener an ECONNRESET mid-run killed the whole
  // process — throwing away a scrape that had already completed successfully.
  client.on('error', error => {
    console.warn('[postgres] client connection error: ' + (error?.message ?? error));
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function reportsTableSql() {
  return `public.${quoteIdentifier(config.supabaseReportsTable)}`;
}

export async function appendReportRowsWithPostgres({
  id,
  headers,
  rowsToAppend,
  uploadedAt
}) {
  return withPostgresClient(async client => {
    const result = await client.query(
      `
        update ${reportsTableSql()}
        set
          headers = $1::jsonb,
          rows = coalesce(rows, '[]'::jsonb) || $2::jsonb,
          uploaded_at = $3::timestamptz
        where id = $4::uuid
        returning id, uploaded_at, jsonb_array_length(rows) as row_count
      `,
      [
        JSON.stringify(headers),
        JSON.stringify(rowsToAppend),
        uploadedAt,
        id
      ]
    );

    return result.rows[0];
  });
}

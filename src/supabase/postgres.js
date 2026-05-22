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

function reportsTableSql() {
  return `public.${quoteIdentifier(config.supabaseReportsTable)}`;
}

export async function appendReportRowsWithPostgres({
  id,
  headers,
  rowsToAppend,
  uploadedAt
}) {
  requireSecret('DATABASE_URL', config.databaseUrl);

  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await client.connect();
  try {
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
  } finally {
    await client.end().catch(() => {});
  }
}

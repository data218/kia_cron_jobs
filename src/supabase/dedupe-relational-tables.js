import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { quoteIdentifier, withPostgresClient } from './postgres.js';
import {
  AM_PLATINUM_TABLES,
  WARRANTY_TABLES,
  groupRowsByIdentityHash,
  resolveBusinessIdentityKey
} from './row-identity.js';

const REPORT_TABLES = [
  'ro_billing_report',
  'kia_call_center_complaints',
  'open_ro_yearly',
  'hyundai_repair_order_list',
  'hyundai_ro_billing_report',
  'hyundai_call_center_complaints',
  'hyundai_customer_complaint_list',
  'hyundai_open_ro_yearly',
  'hyundai_demo_job_cards',
  'hyundai_demo_car_list',
  'hyundai_service_appointment',
  'hyundai_psf_yearly',
  'hyundai_ew_report',
  'hyundai_mcp_report',
  'hyundai_adv_wise_lubricants_vas',
  'hyundai_operation_wise_analysis_report',
  'hyundai_warranty_claim_list',
  'hyundai_warranty_claim_ytp',
  'trust_package',
  ...AM_PLATINUM_TABLES,
  'demo_job_cards',
  'demo_car_list',
  'service_appointment',
  'psf_yearly',
  'ew_report',
  'mcp_report',
  'adv_wise_lubricants_vas',
  'operation_wise_analysis_report',
  'operation_wise_analysis_advisor_report',
  'rsa_report'
];

const BATCH_SIZE = 500;

function parseCliArgs(argv = process.argv.slice(2)) {
  let dryRun = false;
  let tablesArg = null;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg.startsWith('--tables=')) {
      tablesArg = arg.slice('--tables='.length);
    }
  }

  return { dryRun, tablesArg };
}

export function resolveDedupeTables({ tablesArg, defaultTables = REPORT_TABLES } = {}) {
  if (!tablesArg) {
    return defaultTables;
  }

  const tokens = tablesArg.split(',').map(value => value.trim()).filter(Boolean);
  if (tokens.length === 1 && tokens[0] === 'am_platinum_*') {
    return AM_PLATINUM_TABLES;
  }

  return tokens;
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = $1
      limit 1
    `,
    [tableName]
  );

  return result.rowCount > 0;
}

async function deleteRows(client, tableName, ids) {
  if (!ids.length) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const batch = ids.slice(index, index + BATCH_SIZE);
    await client.query(`delete from ${table} where id = any($1::bigint[])`, [batch]);
  }
}

async function updateTemporaryHashes(client, tableName, rows) {
  if (!rows.length) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    await client.query(
      `
        update ${table} as target
        set row_hash = source.temp_hash
        from jsonb_to_recordset($1::jsonb) as source(id bigint, temp_hash text)
        where target.id = source.id
      `,
      [JSON.stringify(batch.map(row => ({
        id: row.id,
        temp_hash: `rehash-temp:${row.id}:${row.newHash}`
      })))]
    );
  }
}

async function updateBusinessIdentityKeys(client, tableName, rows) {
  if (!WARRANTY_TABLES.has(tableName) || !rows.length) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    await client.query(
      `
        update ${table} as target
        set business_identity_key = source.business_identity_key
        from jsonb_to_recordset($1::jsonb) as source(id bigint, business_identity_key text)
        where target.id = source.id
      `,
      [JSON.stringify(batch.map(row => ({
        id: row.id,
        business_identity_key: resolveBusinessIdentityKey(tableName, row.data)
      })).filter(row => row.business_identity_key))]
    );
  }
}

async function updateFinalHashes(client, tableName, rows) {
  if (!rows.length) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    await client.query(
      `
        update ${table} as target
        set row_hash = source.row_hash
        from jsonb_to_recordset($1::jsonb) as source(id bigint, row_hash text)
        where target.id = source.id
      `,
      [JSON.stringify(batch.map(row => ({
        id: row.id,
        row_hash: row.newHash
      })))]
    );
  }
}

export async function dedupeRelationalTables({
  tables = REPORT_TABLES,
  dryRun = false
} = {}) {
  return withPostgresClient(async client => {
    const summaries = [];

    for (const tableName of tables) {
      if (!(await tableExists(client, tableName))) {
        logger.warn('Skipping relational table dedupe because table does not exist', { tableName });
        summaries.push({
          tableName,
          status: 'missing',
          scannedRowCount: 0,
          duplicateGroups: 0,
          deletedDuplicateRowCount: 0,
          retainedRowCount: 0,
          dryRun
        });
        continue;
      }

      const startedAt = Date.now();
      const table = `public.${quoteIdentifier(tableName)}`;
      const result = await client.query(
        `
          select
            id,
            row_hash,
            uploaded_at,
            to_jsonb(${quoteIdentifier(tableName)}) - 'id' - 'row_hash' - 'uploaded_at' - 'business_identity_key' as data
          from ${table}
          order by id
        `
      );

      const {
        rowsToKeep,
        idsToDelete,
        duplicateGroupCount
      } = groupRowsByIdentityHash(tableName, result.rows);

      const rowsNeedingRehash = rowsToKeep.filter(row => row.oldHash !== row.newHash);

      if (!dryRun) {
        await deleteRows(client, tableName, idsToDelete);
        if (rowsNeedingRehash.length > 0) {
          await updateTemporaryHashes(client, tableName, rowsNeedingRehash);
          await updateFinalHashes(client, tableName, rowsNeedingRehash);
        }
        if (WARRANTY_TABLES.has(tableName)) {
          await updateBusinessIdentityKeys(client, tableName, rowsToKeep);
        }
      }

      const summary = {
        tableName,
        status: 'processed',
        scannedRowCount: result.rowCount,
        duplicateGroups: duplicateGroupCount,
        deletedDuplicateRowCount: idsToDelete.length,
        rehashedRowCount: rowsNeedingRehash.length,
        retainedRowCount: rowsToKeep.length,
        dryRun,
        durationMs: Date.now() - startedAt
      };
      summaries.push(summary);
      logger.info(dryRun ? 'Relational table dedupe dry-run completed' : 'Relational table dedupe completed', summary);
    }

    return summaries;
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
}

if (isMainModule()) {
  const { dryRun, tablesArg } = parseCliArgs();
  const tables = resolveDedupeTables({ tablesArg });

  dedupeRelationalTables({ tables, dryRun })
    .then(summaries => {
      console.log(JSON.stringify(summaries, null, 2));
      const deleted = summaries.reduce((sum, item) => sum + (item.deletedDuplicateRowCount ?? 0), 0);
      if (dryRun) {
        console.log(`Dry run complete. Would delete ${deleted} duplicate row(s) across ${summaries.length} table(s).`);
      }
    })
    .catch(error => {
      logger.error('Relational table dedupe failed', error);
      process.exitCode = 1;
    });
}

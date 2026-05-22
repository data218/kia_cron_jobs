import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createSupabaseClient } from './client.js';
import { appendReportRowsWithPostgres } from './postgres.js';
import { saveReportSheetToRelationalTable } from './relational-store.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeHeader(value) {
  return String(value ?? '').trim();
}

function mergeHeaders(existingHeaders, incomingHeaders) {
  const merged = [];
  const seen = new Set();

  for (const header of [...asArray(existingHeaders), ...incomingHeaders]) {
    const normalized = normalizeHeader(header);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    merged.push(normalized);
  }

  return merged;
}

function normalizeRowValue(value) {
  if (value == null) return '';
  return String(value).trim();
}

function rowSignature(row) {
  const entries = Object.entries(row ?? {})
    .map(([key, value]) => [normalizeHeader(key), normalizeRowValue(value)])
    .filter(([key, value]) => key && value !== '')
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  return JSON.stringify(entries);
}

function formatSupabaseError(error) {
  if (!error) return 'Unknown Supabase error';
  if (typeof error === 'string') return error;

  const fields = [
    error.message,
    error.details,
    error.hint,
    error.code,
    error.status,
    error.statusText
  ].filter(Boolean);

  if (fields.length) {
    return fields.join(' | ');
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function mergeRows(existingRows, incomingRows) {
  const mergedRows = [...asArray(existingRows)];
  const signatures = new Set(mergedRows.map(rowSignature));
  let addedRowCount = 0;
  let duplicateRowCount = 0;
  const rowsToAppend = [];

  for (const row of incomingRows) {
    const signature = rowSignature(row);
    if (signatures.has(signature)) {
      duplicateRowCount += 1;
      continue;
    }

    signatures.add(signature);
    mergedRows.push(row);
    rowsToAppend.push(row);
    addedRowCount += 1;
  }

  return {
    rows: mergedRows,
    rowsToAppend,
    addedRowCount,
    duplicateRowCount
  };
}

async function saveRelationalBackup({ sheetName, headers, rows }) {
  try {
    return await saveReportSheetToRelationalTable({
      sheetName,
      headers,
      rows
    });
  } catch (error) {
    logger.error('Relational report save failed; JSON backup save remains intact', {
      sheetName,
      err: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    });
    return {
      failed: true,
      error: error.message
    };
  }
}

export async function saveReportSheetToSupabase({
  brand = 'kia',
  sheetName,
  headers,
  rows
}) {
  if (!Array.isArray(headers) || !headers.length) {
    throw new Error('Cannot save report without headers');
  }

  if (!Array.isArray(rows)) {
    throw new Error('Cannot save report because rows must be an array');
  }

  const supabase = createSupabaseClient();
  const table = config.supabaseReportsTable;
  const uploadedAt = new Date().toISOString();

  const { data: existingRows, error: selectError } = await supabase
    .from(table)
    .select('id, headers, rows')
    .eq('brand', brand)
    .eq('sheet_name', sheetName)
    .order('uploaded_at', { ascending: false })
    .limit(1);

  if (selectError) {
    throw new Error(`Supabase select failed: ${formatSupabaseError(selectError)}`);
  }

  const existing = existingRows?.[0];
  if (existing?.id) {
    const mergedHeaders = mergeHeaders(existing.headers, headers);
    const merged = mergeRows(existing.rows, rows);
    const data = await appendReportRowsWithPostgres({
      id: existing.id,
      headers: mergedHeaders,
      rowsToAppend: merged.rowsToAppend,
      uploadedAt
    });

    const relationalResult = await saveRelationalBackup({
      sheetName,
      headers: mergedHeaders,
      rows: merged.rowsToAppend
    });

    logger.info('Supabase report row merged', {
      table,
      id: data.id,
      brand,
      sheetName,
      headerCount: mergedHeaders.length,
      existingRowCount: asArray(existing.rows).length,
      incomingRowCount: rows.length,
      addedRowCount: merged.addedRowCount,
      duplicateRowCount: merged.duplicateRowCount,
      rowCount: Number(data.row_count ?? merged.rows.length),
      relationalTable: relationalResult.tableName,
      relationalInsertedRowCount: relationalResult.insertedRowCount,
      relationalDuplicateRowCount: relationalResult.duplicateRowCount,
      relationalFailed: relationalResult.failed
    });

    return {
      action: 'merged',
      id: data.id,
      uploadedAt: data.uploaded_at,
      headerCount: mergedHeaders.length,
      rowCount: Number(data.row_count ?? merged.rows.length),
      addedRowCount: merged.addedRowCount,
      duplicateRowCount: merged.duplicateRowCount,
      relationalResult
    };
  }

  const payload = {
    brand,
    sheet_name: sheetName,
    headers,
    rows,
    uploaded_at: uploadedAt
  };

  const { data, error } = await supabase
    .from(table)
    .insert(payload)
    .select('id, uploaded_at')
    .single();

  if (error) {
    throw new Error(`Supabase insert failed: ${formatSupabaseError(error)}`);
  }

  const relationalResult = await saveRelationalBackup({
    sheetName,
    headers,
    rows
  });

  logger.info('Supabase report row inserted', {
    table,
    id: data.id,
    brand,
    sheetName,
    headerCount: headers.length,
    rowCount: rows.length,
    relationalTable: relationalResult.tableName,
    relationalInsertedRowCount: relationalResult.insertedRowCount,
    relationalDuplicateRowCount: relationalResult.duplicateRowCount,
    relationalFailed: relationalResult.failed
  });

  return { action: 'inserted', id: data.id, uploadedAt: data.uploaded_at, relationalResult };
}

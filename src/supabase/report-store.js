import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createSupabaseClient } from './client.js';

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

function mergeRows(existingRows, incomingRows) {
  const mergedRows = [...asArray(existingRows)];
  const signatures = new Set(mergedRows.map(rowSignature));
  let addedRowCount = 0;
  let duplicateRowCount = 0;

  for (const row of incomingRows) {
    const signature = rowSignature(row);
    if (signatures.has(signature)) {
      duplicateRowCount += 1;
      continue;
    }

    signatures.add(signature);
    mergedRows.push(row);
    addedRowCount += 1;
  }

  return {
    rows: mergedRows,
    addedRowCount,
    duplicateRowCount
  };
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
    throw new Error(`Supabase select failed: ${selectError.message}`);
  }

  const existing = existingRows?.[0];
  if (existing?.id) {
    const mergedHeaders = mergeHeaders(existing.headers, headers);
    const merged = mergeRows(existing.rows, rows);
    const payload = {
      brand,
      sheet_name: sheetName,
      headers: mergedHeaders,
      rows: merged.rows,
      uploaded_at: uploadedAt
    };

    const { data, error } = await supabase
      .from(table)
      .update(payload)
      .eq('id', existing.id)
      .select('id, uploaded_at')
      .single();

    if (error) {
      throw new Error(`Supabase update failed: ${error.message}`);
    }

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
      rowCount: merged.rows.length
    });

    return {
      action: 'merged',
      id: data.id,
      uploadedAt: data.uploaded_at,
      headerCount: mergedHeaders.length,
      rowCount: merged.rows.length,
      addedRowCount: merged.addedRowCount,
      duplicateRowCount: merged.duplicateRowCount
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
    throw new Error(`Supabase insert failed: ${error.message}`);
  }

  logger.info('Supabase report row inserted', {
    table,
    id: data.id,
    brand,
    sheetName,
    headerCount: headers.length,
    rowCount: rows.length
  });

  return { action: 'inserted', id: data.id, uploadedAt: data.uploaded_at };
}

import fs from 'node:fs/promises';
import * as XLSX from 'xlsx';

function normalizeHeader(value, index) {
  const header = String(value ?? '').trim();
  return header || `Column ${index + 1}`;
}

function normalizeHeaderPart(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeCellValue(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null) {
    return '';
  }
  return String(value).trim();
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function cloneMatrix(matrix) {
  return matrix.map(row => Array.isArray(row) ? [...row] : []);
}

function fillMergedCells(matrix, merges = []) {
  const filled = cloneMatrix(matrix);

  for (const merge of merges) {
    const sourceValue = filled[merge.s.r]?.[merge.s.c] ?? '';
    if (String(sourceValue ?? '').trim() === '') {
      continue;
    }

    for (let rowIndex = merge.s.r; rowIndex <= merge.e.r; rowIndex += 1) {
      filled[rowIndex] ??= [];
      for (let columnIndex = merge.s.c; columnIndex <= merge.e.c; columnIndex += 1) {
        if (String(filled[rowIndex][columnIndex] ?? '').trim() === '') {
          filled[rowIndex][columnIndex] = sourceValue;
        }
      }
    }
  }

  return filled;
}

function hasDuplicateHeaderGroups(row) {
  const counts = new Map();
  for (const value of row) {
    const text = normalizeHeaderPart(value);
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts.values()].some(count => count >= 2);
}

function isDateLikeText(value) {
  const text = normalizeHeaderPart(value);
  return /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(text) ||
    /^\d{8}$/.test(text) ||
    /^\d{4}-\d{2}-\d{2}/.test(text);
}

function isHeaderLikeCell(value) {
  const text = normalizeHeaderPart(value);
  if (!text) return false;
  if (text.length > 40) return false;
  if (/^\d+([,.]\d+)?$/.test(text)) return false;
  if (isDateLikeText(text)) return false;
  if (text.includes('@')) return false;
  return /[A-Za-z]/.test(text);
}

function headerLikeRatio(row) {
  const cells = row.map(normalizeHeaderPart).filter(Boolean);
  if (!cells.length) return 0;
  return cells.filter(isHeaderLikeCell).length / cells.length;
}

function detectHeaderRowCount(originalRows, mergedRows) {
  if (mergedRows.length < 2) {
    return 1;
  }

  const firstOriginalRow = originalRows[0] ?? [];
  const firstMergedRow = mergedRows[0] ?? [];
  const secondMergedRow = mergedRows[1] ?? [];
  const firstOriginalBlanks = firstOriginalRow.filter(value => !normalizeHeaderPart(value)).length;
  const firstOriginalNonEmpty = firstOriginalRow.filter(value => normalizeHeaderPart(value)).length;
  const hasMergedGroups = hasDuplicateHeaderGroups(firstMergedRow);
  const hasSparseGroupRow = firstOriginalNonEmpty > 0 && firstOriginalBlanks >= firstOriginalNonEmpty;
  const secondRowLooksLikeHeaders = headerLikeRatio(secondMergedRow) >= 0.6;

  return (hasMergedGroups || hasSparseGroupRow) && secondRowLooksLikeHeaders ? 2 : 1;
}

function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((header, index) => {
    const base = normalizeHeader(header, index);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function buildHeaders(headerRows) {
  const width = Math.max(...headerRows.map(row => row.length));
  const rawHeaders = [];
  const seen = new Set();

  for (let index = 0; index < width; index += 1) {
    const parent = normalizeHeaderPart(headerRows[0]?.[index]);
    const child = normalizeHeaderPart(headerRows[1]?.[index]);
    let header = child || parent || `Column ${index + 1}`;

    if (child && parent && child !== parent && seen.has(child)) {
      header = `${parent} ${child}`;
    }

    rawHeaders.push(header);
    seen.add(header);
  }

  return uniqueHeaders(rawHeaders);
}

export function parseExcelBuffer(buffer) {
  if (!buffer.length) {
    throw new Error('Excel file is empty');
  }

  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,
    raw: false
  });

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('Excel workbook has no sheets');
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const rawMatrix = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false
  });

  const mergedMatrix = fillMergedCells(rawMatrix, worksheet['!merges']);

  const nonEmptyRows = mergedMatrix.filter(row =>
    Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== '')
  );
  const originalNonEmptyRows = rawMatrix.filter(row =>
    Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== '')
  );

  if (!nonEmptyRows.length) {
    throw new Error(`Excel sheet "${firstSheetName}" is empty`);
  }

  const headerRowCount = detectHeaderRowCount(originalNonEmptyRows, nonEmptyRows);
  const headers = buildHeaders(nonEmptyRows.slice(0, headerRowCount));
  if (!headers.length) {
    throw new Error(`Excel sheet "${firstSheetName}" has no headers`);
  }

  const rows = nonEmptyRows.slice(headerRowCount).map(row => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = normalizeCellValue(row[index]);
    });
    return record;
  });

  return {
    workbookSheetName: firstSheetName,
    headers,
    rows
  };
}

export async function parseExcelDownload(download) {
  const stream = await download.createReadStream();
  if (!stream) {
    throw new Error('Could not create read stream for downloaded Excel file');
  }

  const buffer = await streamToBuffer(stream);
  return parseExcelBuffer(buffer);
}

export async function parseExcelFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return parseExcelBuffer(buffer);
}

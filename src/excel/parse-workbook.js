import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';

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

function columnNameToNumber(name) {
  return String(name).toUpperCase().split('').reduce((total, char) =>
    total * 26 + char.charCodeAt(0) - 64, 0
  );
}

function parseCellRef(ref) {
  const match = String(ref).match(/^([A-Z]+)(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid Excel cell reference: ${ref}`);
  }

  return {
    r: Number.parseInt(match[2], 10) - 1,
    c: columnNameToNumber(match[1]) - 1
  };
}

function parseMergeRange(range) {
  const [start, end = start] = String(range).split(':');
  return {
    s: parseCellRef(start),
    e: parseCellRef(end)
  };
}

function cellValueToText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) {
    return value.richText.map(part => part.text ?? '').join('');
  }
  if ('result' in value) {
    return cellValueToText(value.result);
  }
  if ('text' in value) {
    return value.text;
  }
  if ('hyperlink' in value && 'text' in value) {
    return value.text;
  }
  return String(value);
}

function worksheetToMatrix(worksheet) {
  const matrix = [];
  const columnCount = worksheet.columnCount;

  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = [];
    for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
      values.push(cellValueToText(row.getCell(columnNumber).value));
    }
    matrix.push(values);
  }

  return matrix;
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

function repeatedChildCounts(headerRows) {
  const counts = new Map();
  const childRow = headerRows[1] ?? [];

  for (const value of childRow) {
    const child = normalizeHeaderPart(value);
    if (!child) continue;
    counts.set(child, (counts.get(child) ?? 0) + 1);
  }

  return counts;
}

function buildHeaders(headerRows) {
  const width = Math.max(...headerRows.map(row => row.length));
  const rawHeaders = [];
  const childCounts = repeatedChildCounts(headerRows);

  for (let index = 0; index < width; index += 1) {
    const parent = normalizeHeaderPart(headerRows[0]?.[index]);
    const child = normalizeHeaderPart(headerRows[1]?.[index]);
    let header = child || parent || `Column ${index + 1}`;

    if (child && parent && child !== parent && (childCounts.get(child) ?? 0) > 1) {
      header = `${parent} ${child}`;
    }

    rawHeaders.push(header);
  }

  return uniqueHeaders(rawHeaders);
}

export async function parseExcelBuffer(buffer) {
  if (!buffer.length) {
    throw new Error('Excel file is empty');
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('Excel workbook has no sheets');
  }

  const firstSheetName = worksheet.name;
  const rawMatrix = worksheetToMatrix(worksheet);
  const merges = (worksheet.model?.merges ?? []).map(parseMergeRange);
  const mergedMatrix = fillMergedCells(rawMatrix, merges);

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

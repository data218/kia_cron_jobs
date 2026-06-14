import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export const PORTAL_EMPTY_ACCEPTANCE_FILE = path.join(
  config.logsDir,
  'am-platinum-portal-empty-acceptance.json'
);

const PRIORITY_STATE_FILES = [
  { phase: 'repair-order', reportIds: ['hyundai-repair-order-list'] },
  { phase: 'ro-billing', reportIds: ['hyundai-ro-billing-report'] },
  {
    phase: 'trust-package',
    reportIds: [
      'hyundai-trust-package-bodyshop-sot',
      'hyundai-trust-package-sot-super',
      'hyundai-trust-package-package-list'
    ]
  }
];

const OP_WISE_NAME_RE = /AM Platinum Operation Wise - (N\d+) (Operation|Part) (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/;
const OP_WISE_REPORT_ID = 'hyundai-operation-wise-analysis-report';

function makeOperationWiseAcceptance(dealerCode, reportType, startIso, endIso, source) {
  return {
    reportId: OP_WISE_REPORT_ID,
    dealerCode,
    reportType,
    startIso,
    endIso,
    kind: 'no_rows',
    source,
    phase: 'operation-wise',
    recordedAt: new Date().toISOString()
  };
}

function operationWiseAttemptWasEmpty(window) {
  if (window.includes('Operation wise month has no data') && window.includes('"noData":true')) {
    return true;
  }

  const hasDbRows = /"incomingRowCount":([1-9]\d*)/.test(window)
    || /"insertedRowCount":([1-9]\d*)/.test(window)
    || /"updatedRowCount":([1-9]\d*)/.test(window);

  if (hasDbRows) {
    return false;
  }

  if (/"rowCount":0,"msg":"Excel export parsed"/.test(window)) {
    return true;
  }

  return window.includes('No data');
}

function parseJsonLine(line) {
  const start = line.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(line.slice(start));
  } catch {
    return null;
  }
}

async function readLogFileContent(filePath) {
  const buffer = await fs.readFile(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

async function buildAcceptancesFromOperationWiseLogs(logsDir) {
  const entries = [];
  let files;

  try {
    files = await fs.readdir(logsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return entries;
    throw error;
  }

  const logFiles = files.filter(file =>
    file.endsWith('.log') && file.includes('op-wise')
  );

  for (const file of logFiles) {
    const content = await readLogFileContent(path.join(logsDir, file));
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const json = parseJsonLine(line);

      if (json?.msg === 'Operation wise month has no data; skipping pager size and export') {
        const dealerCode = json.dealerCode
          || line.match(OP_WISE_NAME_RE)?.[1]
          || findOperationWiseDealerBefore(lines, index);
        if (dealerCode && json.reportType && json.rangeStart && json.rangeEnd) {
          entries.push(makeOperationWiseAcceptance(
            dealerCode,
            json.reportType,
            json.rangeStart,
            json.rangeEnd,
            `operation-wise-log:${file}`
          ));
        }
        continue;
      }

      const nameMatch = line.match(/"name":"AM Platinum Operation Wise - (N\d+) (Operation|Part) (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})"/)
        || line.match(OP_WISE_NAME_RE);
      if (!nameMatch) continue;

      const [, dealerCode, reportType, startIso, endIso] = nameMatch;
      const window = lines.slice(index, index + 25).join('\n');
      if (!operationWiseAttemptWasEmpty(window)) continue;

      entries.push(makeOperationWiseAcceptance(
        dealerCode,
        reportType,
        startIso,
        endIso,
        `operation-wise-log:${file}`
      ));
    }
  }

  return entries;
}

function findOperationWiseDealerBefore(lines, index) {
  for (let cursor = index; cursor >= Math.max(0, index - 25); cursor -= 1) {
    const match = lines[cursor].match(OP_WISE_NAME_RE)
      || lines[cursor].match(/"name":"AM Platinum Operation Wise - (N\d+)/);
    if (match) return match[1];
  }
  return null;
}

function entryKey(entry) {
  return [
    entry.reportId,
    entry.dealerCode,
    entry.reportType ?? '',
    entry.startIso,
    entry.endIso,
    entry.kind
  ].join('|');
}

function monthKey(isoDate) {
  return String(isoDate).slice(0, 7);
}

function listMonthsBefore(minDateIso, targetStartIso) {
  const months = [];
  const target = monthKey(targetStartIso);
  const before = monthKey(minDateIso);
  if (before <= target) return months;

  let cursor = target;
  while (cursor < before) {
    months.push(cursor);
    const [year, month] = cursor.split('-').map(Number);
    const next = month === 12
      ? `${year + 1}-01`
      : `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`;
    cursor = next;
  }
  return months;
}

function monthOverlapsRange(month, startIso, endIso) {
  const [year, monthNum] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const lastDay = new Date(year, monthNum, 0).getDate();
  const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;
  return monthStart <= endIso && monthEnd >= startIso;
}

function hasNoRowsForMonth(acceptances, { reportId, dealerCode, reportType, month }) {
  return acceptances.some(entry =>
    entry.kind === 'no_rows' &&
    entry.reportId === reportId &&
    entry.dealerCode === dealerCode &&
    (reportType ? entry.reportType === reportType : !entry.reportType) &&
    monthOverlapsRange(month, entry.startIso, entry.endIso)
  );
}

export async function loadPortalEmptyAcceptances() {
  try {
    const raw = await fs.readFile(PORTAL_EMPTY_ACCEPTANCE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function savePortalEmptyAcceptances(entries) {
  const deduped = new Map();
  for (const entry of entries) {
    deduped.set(entryKey(entry), entry);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    entries: [...deduped.values()].sort((left, right) =>
      `${left.reportId}|${left.dealerCode}|${left.startIso}`.localeCompare(
        `${right.reportId}|${right.dealerCode}|${right.startIso}`
      )
    )
  };

  await fs.mkdir(config.logsDir, { recursive: true });
  await fs.writeFile(PORTAL_EMPTY_ACCEPTANCE_FILE, JSON.stringify(payload, null, 2));
  return payload.entries;
}

export async function recordPortalEmptyAcceptance(entry) {
  const existing = await loadPortalEmptyAcceptances();
  const normalized = {
    ...entry,
    kind: entry.kind || 'no_rows',
    source: entry.source || 'priority-gapfill',
    recordedAt: entry.recordedAt || new Date().toISOString()
  };
  existing.push(normalized);
  return savePortalEmptyAcceptances(existing);
}

function historicalResultsToAcceptances(state, reportId, phase) {
  const entries = [];
  if (!state?.results?.length) return entries;

  for (const result of state.results) {
    if (result.status !== 'success') continue;
    const isEmpty = result.dbAction === 'no_rows' || Number(result.rowCount ?? 0) === 0;
    if (!isEmpty) continue;

    entries.push({
      reportId: result.reportId || reportId,
      dealerCode: result.dealerCode,
      startIso: result.startIso,
      endIso: result.endIso,
      kind: 'no_rows',
      source: 'priority-gapfill',
      phase,
      recordedAt: state.completedAt || state.updatedAt || new Date().toISOString()
    });
  }

  return entries;
}

export async function refreshPortalEmptyAcceptancesFromPriorityStates() {
  const merged = await loadPortalEmptyAcceptances();

  for (const { phase, reportIds } of PRIORITY_STATE_FILES) {
    const statePath = path.join(config.logsDir, `am-platinum-priority-${phase}-state.json`);
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      const state = JSON.parse(raw);
      for (const reportId of reportIds) {
        merged.push(...historicalResultsToAcceptances(state, reportId, phase));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  merged.push(...await buildAcceptancesFromOperationWiseLogs(config.logsDir));

  return savePortalEmptyAcceptances(merged);
}

function endGapAccepted(dealer, acceptances, reportId, dealerCode, currentMonthStart, extraReportIds = []) {
  if (!dealer.maxDate || dealer.maxDate >= currentMonthStart) return false;

  const reportIds = new Set([reportId, ...(extraReportIds ?? [])]);
  return acceptances.some(entry =>
    entry.kind === 'no_rows' &&
    reportIds.has(entry.reportId) &&
    entry.dealerCode === dealerCode &&
    entry.startIso >= currentMonthStart
  );
}

function startGapAccepted(dealer, acceptances, reportId, dealerCode, targetStart, reportType = null) {
  if (!dealer.minDate || dealer.minDate <= targetStart) return false;

  const months = listMonthsBefore(dealer.minDate, targetStart);
  if (!months.length) return false;

  return months.every(month =>
    hasNoRowsForMonth(acceptances, { reportId, dealerCode, reportType, month })
  );
}

export function applyPortalEmptyAcceptance(dealer, {
  reportId,
  dealerCode,
  targetStart,
  currentMonthStart,
  extraReportIds = [],
  acceptances = []
}) {
  if (dealer.complete || !acceptances.length) {
    return dealer;
  }

  if (dealer.reportTypes?.length) {
    const reportTypes = dealer.reportTypes.map(typeEntry => {
      if (typeEntry.complete) return typeEntry;

      const endOk = !typeEntry.maxDate || typeEntry.maxDate >= currentMonthStart;
      const startOk = !typeEntry.minDate || typeEntry.minDate <= targetStart;

      if (!startOk && startGapAccepted(typeEntry, acceptances, reportId, dealerCode, targetStart, typeEntry.reportType)) {
        return {
          ...typeEntry,
          complete: endOk,
          portalEmptyAccepted: true,
          acceptanceNote: `portal floor at ${typeEntry.minDate} (${typeEntry.reportType}; earlier months empty in portal)`
        };
      }

      if (typeEntry.rowCount === 0 && endGapAccepted(
        typeEntry,
        acceptances,
        reportId,
        dealerCode,
        currentMonthStart,
        extraReportIds
      )) {
        return {
          ...typeEntry,
          complete: true,
          portalEmptyAccepted: true,
          acceptanceNote: 'portal empty (accepted)'
        };
      }

      return typeEntry;
    });

    const complete = reportTypes.every(entry => entry.complete);
    const acceptedNotes = reportTypes
      .filter(entry => entry.portalEmptyAccepted && entry.acceptanceNote)
      .map(entry => entry.acceptanceNote);

    return {
      ...dealer,
      reportTypes,
      complete,
      portalEmptyAccepted: complete && acceptedNotes.length > 0,
      reasons: complete && acceptedNotes.length
        ? acceptedNotes
        : dealer.reasons
    };
  }

  if (dealer.rowCount === 0 && endGapAccepted(dealer, acceptances, reportId, dealerCode, currentMonthStart, extraReportIds)) {
    return {
      ...dealer,
      complete: true,
      portalEmptyAccepted: true,
      reasons: ['portal empty (accepted)']
    };
  }

  if (startGapAccepted(dealer, acceptances, reportId, dealerCode, targetStart)) {
    const endOk = !dealer.maxDate || dealer.maxDate >= currentMonthStart;
    return {
      ...dealer,
      complete: endOk,
      portalEmptyAccepted: true,
      reasons: [`portal floor at ${dealer.minDate} (earlier months empty in portal)`]
    };
  }

  if (endGapAccepted(dealer, acceptances, reportId, dealerCode, currentMonthStart, extraReportIds)) {
    return {
      ...dealer,
      complete: true,
      portalEmptyAccepted: true,
      reasons: [`portal empty from ${currentMonthStart} (accepted)`]
    };
  }

  return dealer;
}

export function applyPortalAcceptancesToTableResult(result, acceptances, currentMonthStart) {
  if (!result.exists || !acceptances.length) return result;

  const targetStart = result.targetStart ?? '2021-01-01';
  const dealers = { ...result.dealers };

  for (const dealerCode of Object.keys(dealers)) {
    dealers[dealerCode] = applyPortalEmptyAcceptance(dealers[dealerCode], {
      reportId: result.reportId,
      dealerCode,
      targetStart,
      currentMonthStart,
      extraReportIds: result.extraReportIds,
      acceptances
    });
  }

  return { ...result, dealers };
}

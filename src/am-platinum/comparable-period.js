import { config } from '../config.js';
import { quoteIdentifier, withPostgresClient } from '../supabase/postgres.js';
import {
  formatDateForPortal,
  getCalendarMonthRanges,
  getCurrentMonthToDateRange,
  parseIsoLocalDate,
  toIsoDate
} from '../utils/date-range.js';

export const OPERATION_WISE_TABLE = 'am_platinum_operation_wise_analysis_report';
export const VAS_PERIOD_SUMMARY_VIEW = 'am_platinum_vas_period_summary_v1';
export const OPERATION_WISE_REPORT_TYPES = ['Operation', 'Part'];

export function getCurrentYearToDateRange(today = new Date()) {
  return getCurrentMonthToDateRange(today);
}

export function buildRangeFromIsoDates(startIso, endIso) {
  const startDate = parseIsoLocalDate(startIso);
  const endDate = parseIsoLocalDate(endIso);
  const reportMonth = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  return {
    startDate,
    endDate,
    reportMonth,
    reportMonthIso: toIsoDate(reportMonth),
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso,
    endIso
  };
}

export function getLastYearComparableRange(cyStartIso, cyEndIso) {
  const cyStart = parseIsoLocalDate(cyStartIso);
  const cyEnd = parseIsoLocalDate(cyEndIso);
  const lyStart = new Date(cyStart.getFullYear() - 1, cyStart.getMonth(), cyStart.getDate());
  const lyEnd = new Date(cyEnd.getFullYear() - 1, cyEnd.getMonth(), cyEnd.getDate());

  return buildRangeFromIsoDates(toIsoDate(lyStart), toIsoDate(lyEnd));
}

export function isPeriodComparableToWindow(periodStart, periodEnd, windowStart, windowEnd) {
  const pStart = String(periodStart).slice(0, 10);
  const pEnd = String(periodEnd ?? periodStart).slice(0, 10);
  const wStart = String(windowStart).slice(0, 10);
  const wEnd = String(windowEnd).slice(0, 10);

  if (pStart === wStart && pEnd === wEnd) {
    return { comparable: true, reason: 'exact match' };
  }

  if (pStart >= wStart && pEnd <= wEnd) {
    return { comparable: true, reason: 'covered inside window' };
  }

  return { comparable: false, reason: 'period outside comparable window' };
}

export function defaultDealerCodes() {
  return config.amPlatinumDealerCodes?.length
    ? config.amPlatinumDealerCodes
    : ['N5211', 'N6250', 'N6828'];
}

export async function listPeriodsForDealer(client, dealerCode) {
  const result = await client.query(
    `SELECT report_period_start::date AS period_start,
            report_period_end::date AS period_end,
            COUNT(*)::int AS row_count
     FROM public.${quoteIdentifier(OPERATION_WISE_TABLE)}
     WHERE UPPER(TRIM(source_dealer_code::text)) = UPPER(TRIM($1::text))
     GROUP BY 1, 2
     ORDER BY 1 DESC, 2 DESC`,
    [dealerCode]
  );

  return result.rows.map(row => ({
    periodStart: toIsoDate(row.period_start),
    periodEnd: toIsoDate(row.period_end),
    rowCount: Number(row.row_count ?? 0)
  }));
}

export async function exactPeriodExists(client, {
  dealerCode,
  reportType = null,
  periodStart,
  periodEnd
}) {
  const params = [dealerCode, periodStart, periodEnd];
  let typeFilter = '';

  if (reportType) {
    params.push(String(reportType).trim());
    typeFilter = `AND LOWER(TRIM(report_type::text)) = LOWER(TRIM($${params.length}::text))`;
  }

  const result = await client.query(
    `SELECT COUNT(*)::int AS row_count
     FROM public.${quoteIdentifier(OPERATION_WISE_TABLE)}
     WHERE UPPER(TRIM(source_dealer_code::text)) = UPPER(TRIM($1::text))
       AND report_period_start = $2::date
       AND report_period_end = $3::date
       ${typeFilter}`,
    params
  );

  return Number(result.rows[0]?.row_count ?? 0);
}

export async function buildMissingComparableRanges(client, {
  dealerCode,
  cyStartIso,
  cyEndIso,
  reportTypes = OPERATION_WISE_REPORT_TYPES
}) {
  const cyRange = buildRangeFromIsoDates(cyStartIso, cyEndIso);
  const lyRange = getLastYearComparableRange(cyStartIso, cyEndIso);
  const missing = [];

  for (const range of [cyRange, lyRange]) {
    let needsRange = false;

    for (const reportType of reportTypes) {
      const existingRows = await exactPeriodExists(client, {
        dealerCode,
        reportType,
        periodStart: range.startIso,
        periodEnd: range.endIso
      });

      if (existingRows === 0) {
        needsRange = true;
        break;
      }
    }

    if (needsRange) {
      missing.push(range);
    }
  }

  return missing;
}

export async function periodNeedsLySlice(client, {
  dealerCode,
  cyStartIso,
  cyEndIso,
  reportType = null
}) {
  const lyRange = getLastYearComparableRange(cyStartIso, cyEndIso);
  const existingRows = await exactPeriodExists(client, {
    dealerCode,
    reportType,
    periodStart: lyRange.startIso,
    periodEnd: lyRange.endIso
  });

  return {
    needed: existingRows === 0,
    lyRange,
    existingRows
  };
}

export async function getComparableLyStatus(client, {
  dealerCode,
  cyStartIso,
  cyEndIso
}) {
  const lyRange = getLastYearComparableRange(cyStartIso, cyEndIso);
  const periods = await listPeriodsForDealer(client, dealerCode);
  const exactRows = await exactPeriodExists(client, {
    dealerCode,
    periodStart: lyRange.startIso,
    periodEnd: lyRange.endIso
  });

  const comparablePeriod = periods.find(period =>
    isPeriodComparableToWindow(
      period.periodStart,
      period.periodEnd,
      lyRange.startIso,
      lyRange.endIso
    ).comparable
  );

  return {
    cyStartIso,
    cyEndIso,
    lyStartIso: lyRange.startIso,
    lyEndIso: lyRange.endIso,
    exactLyRows: exactRows,
    hasExactLyPeriod: exactRows > 0,
    hasComparableLyPeriod: Boolean(comparablePeriod),
    comparablePeriod,
    fullMonthOnly: periods.some(period => {
      const monthEnd = toIsoDate(new Date(
        parseIsoLocalDate(lyRange.startIso).getFullYear(),
        parseIsoLocalDate(lyRange.startIso).getMonth() + 1,
        0
      ));
      return period.periodStart === lyRange.startIso &&
        period.periodEnd === monthEnd &&
        period.periodEnd !== lyRange.endIso;
    })
  };
}

export function buildMonthlyComparableCyWindows(fromIso, toIso, today = new Date()) {
  const fromDate = parseIsoLocalDate(fromIso);
  const toDate = parseIsoLocalDate(toIso);
  const capEnd = toDate > today
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
    : toDate;

  return getCalendarMonthRanges(fromDate, capEnd).map(range => ({
    cyStartIso: range.startIso,
    cyEndIso: range.endIso,
    label: range.startIso.slice(0, 7)
  }));
}

export function dedupeRangesByPeriod(ranges) {
  const map = new Map();

  for (const range of ranges) {
    map.set(`${range.startIso}|${range.endIso}`, range);
  }

  return [...map.values()].sort((left, right) =>
    left.startIso.localeCompare(right.startIso) || left.endIso.localeCompare(right.endIso));
}

export async function buildAllMissingComparableRanges(client, {
  dealerCode,
  fromIso,
  toIso,
  cyOnly = false,
  lyOnly = false,
  today = new Date()
}) {
  const windows = buildMonthlyComparableCyWindows(fromIso, toIso, today);
  const missing = [];

  for (const window of windows) {
    const cyRange = buildRangeFromIsoDates(window.cyStartIso, window.cyEndIso);
    const lyRange = getLastYearComparableRange(window.cyStartIso, window.cyEndIso);
    const windowMissing = await buildMissingComparableRanges(client, {
      dealerCode,
      cyStartIso: window.cyStartIso,
      cyEndIso: window.cyEndIso
    });

    for (const range of windowMissing) {
      const isCy = range.startIso === cyRange.startIso && range.endIso === cyRange.endIso;
      const isLy = range.startIso === lyRange.startIso && range.endIso === lyRange.endIso;

      if (cyOnly && !isCy) continue;
      if (lyOnly && !isLy) continue;
      missing.push(range);
    }
  }

  return dedupeRangesByPeriod(missing);
}

export async function queryVasPeriodSummary(client, dealerCode) {
  try {
    const result = await client.query(
      `SELECT period_start, period_end, vas_amount, source_rows
       FROM public.${quoteIdentifier(VAS_PERIOD_SUMMARY_VIEW)}
       WHERE UPPER(TRIM(dealer_code::text)) = UPPER(TRIM($1::text))
       ORDER BY period_start DESC
       LIMIT 12`,
      [dealerCode]
    );
    return result.rows;
  } catch (error) {
    if (error.message?.includes('does not exist')) {
      return null;
    }
    throw error;
  }
}

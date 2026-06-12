import { config } from '../config.js';

function pad(value) {
  return String(value).padStart(2, '0');
}

export function toIsoDate(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-');
}

export function formatDateForPortal(date, format = config.reportDateFormat) {
  const dd = pad(date.getDate());
  const mm = pad(date.getMonth() + 1);
  const yyyy = String(date.getFullYear());

  return format
    .replaceAll('DD', dd)
    .replaceAll('MM', mm)
    .replaceAll('YYYY', yyyy);
}

export function getRollingOneMonthPlusOneDayRange(today = new Date()) {
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - 1);
  startDate.setDate(startDate.getDate() + 1);

  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

export function getRollingThreeMonthRange(today = new Date()) {
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - 3);

  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

export function getRollingTwoMonthRange(today = new Date()) {
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - 2);

  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

export function getCurrentMonthToDateRange(today = new Date()) {
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

export function parseIsoLocalDate(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return new Date(year, month - 1, day);
}

export function getReportDateOverrideRange() {
  const startValue = config.reportDateOverrideStartDate;
  const endValue = config.reportDateOverrideEndDate;
  if (!startValue && !endValue) {
    return null;
  }

  const startDate = parseIsoLocalDate(startValue || endValue);
  const endDate = parseIsoLocalDate(endValue || startValue);

  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

export function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

export function getThirtyDayChunks(startDate, endDate) {
  const chunks = [];
  let currentStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const finalEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());

  while (currentStart <= finalEnd) {
    const currentEnd = addDays(currentStart, 29);
    const cappedEnd = currentEnd > finalEnd ? finalEnd : currentEnd;
    chunks.push({
      startDate: currentStart,
      endDate: cappedEnd,
      startPortal: formatDateForPortal(currentStart),
      endPortal: formatDateForPortal(cappedEnd),
      startIso: toIsoDate(currentStart),
      endIso: toIsoDate(cappedEnd)
    });
    currentStart = addDays(cappedEnd, 1);
  }

  return chunks;
}

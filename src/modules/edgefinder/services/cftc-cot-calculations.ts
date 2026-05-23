/**
 * Pure calculation helpers for transforming raw CFTC rows into our schema.
 * Extracted for clean unit testing.
 */

export interface CftcDerivedFields {
  longContracts: number;
  shortContracts: number;
  longPct: number;
  shortPct: number;
  changeInLongContracts: number;
  changeInShortContracts: number;
  changeInLongPct: number | null;
  changeInShortPct: number | null;
  weeklyChangePct: number | null;
}

export function computeCotDerivedFields(
  longAll: number,
  shortAll: number,
  changeLong: number,
  changeShort: number,
): CftcDerivedFields {
  const denominator = longAll + shortAll;
  const longPct = denominator > 0 ? (longAll / denominator) * 100 : 50;
  const shortPct = denominator > 0 ? (shortAll / denominator) * 100 : 50;

  const lastWeekLong = longAll - changeLong;
  const lastWeekShort = shortAll - changeShort;

  const changeInLongPct =
    lastWeekLong > 0 ? (changeLong / lastWeekLong) * 100 : null;
  const changeInShortPct =
    lastWeekShort > 0 ? (changeShort / lastWeekShort) * 100 : null;

  const weeklyChangePct =
    changeInLongPct !== null && changeInShortPct !== null
      ? changeInLongPct - changeInShortPct
      : null;

  return {
    longContracts: longAll,
    shortContracts: shortAll,
    longPct,
    shortPct,
    changeInLongContracts: changeLong,
    changeInShortContracts: changeShort,
    changeInLongPct,
    changeInShortPct,
    weeklyChangePct,
  };
}

/**
 * Compute release date from report date.
 * CFTC report dates are Tuesdays; the Friday release is 3 days later.
 */
export function computeReleaseDate(reportDate: Date): Date {
  const result = new Date(reportDate);
  result.setUTCDate(result.getUTCDate() + 3);
  return result;
}

/**
 * Parse 'YYYY-MM-DDT...' style string into a UTC date-only Date object.
 */
export function parseCftcReportDate(dateStr: string): Date {
  const datePart = dateStr.split('T')[0];
  const parts = datePart.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    throw new Error(`Invalid CFTC report date: ${dateStr}`);
  }
  return new Date(Date.UTC(year, month - 1, day));
}

export function safeParseInt(
  value: string | undefined | null,
): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

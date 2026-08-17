import { prisma } from '@core/db/prisma';

/**
 * NSE trading-day helpers. A date is a trading day iff it is not a weekend
 * (UTC day-of-week) AND not listed in the `nse_holidays` table (NseHoliday
 * model — see prisma/schema.prisma for coverage and source).
 *
 * Introduced 2026-08-17 (data-layer-integrity phase). Used by:
 *   - scorecard-assembly trigger paths (cron, admin manual, admin direct) —
 *     refuse to generate a NiftyScorecard for a non-trading day.
 *   - sub-tools/velocity.ts — sessions between two dates, trading-day count.
 *
 * All dates are treated as UTC-midnight `Date` objects, consistent with how
 * observationDate is stored/compared everywhere else in this module.
 */

function toDateOnlyUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Returns true if `date` is not a Sat/Sun AND not in nse_holidays.
 * One DB round-trip per call — fine for the low call volume here (a handful
 * of scorecard-trigger checks per day); callers computing many dates at once
 * should use `getHolidaySet` + `isWeekend` directly instead of calling this
 * in a loop.
 */
export async function isTradingDay(date: Date): Promise<boolean> {
  const d = toDateOnlyUtc(date);
  if (isWeekend(d)) return false;
  const holiday = await prisma.nseHoliday.findUnique({ where: { date: d } });
  return holiday === null;
}

/**
 * Loads all holiday dates in [from, to] (inclusive) as a Set of
 * YYYY-MM-DD strings, for callers that need to check many dates without a
 * round-trip per date (e.g. counting trading days across a history window).
 */
export async function getHolidaySet(from: Date, to: Date): Promise<Set<string>> {
  const rows = await prisma.nseHoliday.findMany({
    where: { date: { gte: toDateOnlyUtc(from), lte: toDateOnlyUtc(to) } },
    select: { date: true },
  });
  return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
}

/**
 * Counts NSE trading days strictly after `fromDateExclusive` and up to and
 * including `toDateInclusive`. Mirrors the (start, end] convention the old
 * row-counting sessionsBetween() used, so callers didn't need to change
 * their date-range semantics — only what gets counted.
 */
export async function countTradingDaysBetween(
  fromDateExclusive: Date,
  toDateInclusive: Date,
): Promise<number> {
  const from = toDateOnlyUtc(fromDateExclusive);
  const to = toDateOnlyUtc(toDateInclusive);
  if (to <= from) return 0;

  const holidays = await getHolidaySet(from, to);

  let count = 0;
  const cursor = new Date(from);
  cursor.setUTCDate(cursor.getUTCDate() + 1); // start the day after `from`
  while (cursor <= to) {
    if (!isWeekend(cursor) && !holidays.has(cursor.toISOString().slice(0, 10))) {
      count++;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

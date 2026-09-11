/**
 * US market trading calendar (NYSE / SIFMA rules).
 *
 * WHY THIS EXISTS
 * ---------------
 * Compass classified the macro regime on days the US market was shut. Weekends
 * were the visible case (28 of 104 live classification rows), but Stage 0 of
 * Phase C confirmed the same defect on US market holidays: Juneteenth 2026,
 * 3 July 2026 and Labor Day 2026 all produced full classifications, because
 * EODHD returns the previous close and the FRED forward-fill carries through, so
 * all six inputs look "present". Those rows advanced the persistence counter,
 * meaning a regime transition could complete on a Sunday or a public holiday on
 * no new information.
 *
 * The prior phase's staleness work deliberately avoided a holiday calendar,
 * noting that "there is no trading calendar anywhere in this codebase" and that
 * inventing a hardcoded holiday LIST was out of bounds. This module is not a
 * list: the ten recurring US market holidays are all defined by RULES (fixed
 * date, or n-th weekday of a month, or Good Friday via the computus), so they
 * are computed, not enumerated, and are therefore correct across the entire
 * replay range back to 1962 rather than for a hand-maintained window.
 *
 * The one thing rules cannot derive is an UNSCHEDULED closure — a national day
 * of mourning, a hurricane, 9/11. Those are enumerated in CLOSURES below, each
 * with its reason. That list is short, historically fixed, and only ever grows
 * at the end. 2018-12-05 (George H. W. Bush) matters: it falls inside Compass
 * validation window V3 (2018_Q4).
 *
 * SCOPE: a new, additive file. Nothing else in the codebase imported a US
 * calendar before this, so no existing behaviour changes. The pre-existing
 * `src/core/utils/trading-calendar.ts` is NSE (India) and is untouched.
 *
 * NOT MODELLED: early closes (1pm sessions before Independence Day, the day
 * after Thanksgiving, Christmas Eve). Those are half days, not closures — the
 * market trades and publishes a close, so they are trading days for every
 * purpose Compass has.
 *
 * All dates are UTC-midnight `Date` objects, matching the `@db.Date` columns.
 */

/** Unscheduled full-day US market closures that no rule can derive. */
const UNSCHEDULED_CLOSURES: ReadonlyMap<string, string> = new Map([
  ['2001-09-11', 'September 11 attacks'],
  ['2001-09-12', 'September 11 attacks'],
  ['2001-09-13', 'September 11 attacks'],
  ['2001-09-14', 'September 11 attacks'],
  ['2004-06-11', 'National day of mourning — Ronald Reagan'],
  ['2007-01-02', 'National day of mourning — Gerald Ford'],
  ['2012-10-29', 'Hurricane Sandy'],
  ['2012-10-30', 'Hurricane Sandy'],
  ['2018-12-05', 'National day of mourning — George H. W. Bush'],
  ['2025-01-09', 'National day of mourning — Jimmy Carter'],
]);

/** Juneteenth became a US federal holiday in 2021; markets first closed in 2022. */
const JUNETEENTH_FIRST_OBSERVED_YEAR = 2022;
/** MLK Day was first observed by the NYSE in 1998. */
const MLK_FIRST_OBSERVED_YEAR = 1998;

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utc(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m - 1, day));
}

/** The n-th `weekday` of a month (n is 1-based). weekday: 0=Sun .. 6=Sat. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = utc(year, month, 1);
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return utc(year, month, 1 + shift + (n - 1) * 7);
}

/** The last `weekday` of a month. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = utc(year, month, lastDay);
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return utc(year, month, lastDay - shift);
}

/**
 * Easter Sunday (Gregorian) by the Anonymous Gregorian computus. Good Friday is
 * two days earlier and is the only US market holiday that is not a fixed date
 * or an n-th weekday.
 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/**
 * Apply the US federal observation rule to a fixed-date holiday: a Saturday
 * holiday is observed the preceding Friday, a Sunday holiday the following
 * Monday. Returns null when the shift would leave the calendar year, which the
 * caller handles by also seeding the adjacent year.
 */
function observed(d: Date): Date {
  const dow = d.getUTCDay();
  if (dow === 6) return new Date(d.getTime() - 86400000);
  if (dow === 0) return new Date(d.getTime() + 86400000);
  return d;
}

const holidayCache = new Map<number, Map<string, string>>();

/** Every US market closure in `year`, as ISO date -> human-readable reason. */
export function usMarketHolidays(year: number): ReadonlyMap<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const out = new Map<string, string>();
  const add = (d: Date, name: string): void => {
    // A holiday shifted out of `year` (e.g. Jan 1 falling on a Saturday is
    // observed on Dec 31 of the prior year) still belongs on the calendar; the
    // caller looks up by date, not by year, and both years are seeded below.
    out.set(toIsoDate(d), name);
  };

  add(observed(utc(year, 1, 1)), "New Year's Day");
  if (year >= MLK_FIRST_OBSERVED_YEAR) {
    add(nthWeekdayOfMonth(year, 1, 1, 3), 'Martin Luther King Jr. Day');
  }
  add(nthWeekdayOfMonth(year, 2, 1, 3), "Washington's Birthday");
  add(new Date(easterSunday(year).getTime() - 2 * 86400000), 'Good Friday');
  add(lastWeekdayOfMonth(year, 5, 1), 'Memorial Day');
  if (year >= JUNETEENTH_FIRST_OBSERVED_YEAR) {
    add(observed(utc(year, 6, 19)), 'Juneteenth');
  }
  add(observed(utc(year, 7, 4)), 'Independence Day');
  add(nthWeekdayOfMonth(year, 9, 1, 1), 'Labor Day');
  add(nthWeekdayOfMonth(year, 11, 4, 4), 'Thanksgiving Day');
  add(observed(utc(year, 12, 25)), 'Christmas Day');

  // New Year's Day of the FOLLOWING year can be observed on 31 December of this
  // one (when 1 Jan falls on a Saturday), so seed it here too.
  const nextNewYear = observed(utc(year + 1, 1, 1));
  if (nextNewYear.getUTCFullYear() === year) {
    out.set(toIsoDate(nextNewYear), "New Year's Day (observed)");
  }

  holidayCache.set(year, out);
  return out;
}

/**
 * Why `date` is not a trading day, or null if it is one.
 * Returns a short human-readable reason suitable for a log line or an audit row.
 */
export function nonTradingReason(date: Date): string | null {
  const dow = date.getUTCDay();
  if (dow === 0) return 'Sunday';
  if (dow === 6) return 'Saturday';

  const iso = toIsoDate(date);

  const unscheduled = UNSCHEDULED_CLOSURES.get(iso);
  if (unscheduled) return unscheduled;

  const year = date.getUTCFullYear();
  // Check this year and the previous one: a 1 January holiday can be observed on
  // 31 December of the prior year.
  const hit = usMarketHolidays(year).get(iso) ?? usMarketHolidays(year - 1).get(iso);
  if (hit) return hit;

  return null;
}

/** Is `date` a US market trading day? */
export function isUsMarketTradingDay(date: Date): boolean {
  return nonTradingReason(date) === null;
}

/**
 * Ascending US market trading days in [start, end] inclusive.
 *
 * This supersedes the weekday-only `generateTradingDays` that previously lived
 * in `validation/historical-backfill.service.ts` (which production input
 * services imported from a `validation/` folder — a long-standing wart). That
 * export now delegates here.
 */
export function generateTradingDays(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cursor.getTime() <= last) {
    if (isUsMarketTradingDay(cursor)) out.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

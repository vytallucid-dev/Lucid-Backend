/**
 * Phase 5 — staleness + forward-fill + observation-indexed lookbacks.
 *
 * Pure logic, no I/O: this module only cleans a series the caller has
 * already fetched (real stored observations) against a reference trading-day
 * calendar (also caller-fetched), so it is fully unit-testable.
 *
 * "Trading day" definition: there is no trading calendar anywhere in this
 * codebase, and the task's hard rule forbids inventing a hardcoded holiday
 * list. Instead, a REFERENCE SERIES with reliable daily coverage stands in
 * for the calendar — VIX.INDX's own stored compass_inputs dates for market
 * data (VIX/VIX3M/DXY/USDJPY all trade on the same market calendar as VIX),
 * and the stale FRED series' own stored dates for HY_OAS/T10Y2Y (FRED series
 * publish on the same US business-day calendar). Concretely: the caller
 * passes an ascending list of dates (`referenceCalendar`) drawn from a
 * series believed to have reliable coverage, and staleness/observation
 * counts are measured as index positions against THAT list.
 *
 * Failure mode of this approach: if the reference series itself has a gap
 * on a given day (e.g. its own fetch failed), every OTHER series' staleness
 * count is thrown off for that day, because the reference calendar itself
 * is missing an entry. This is an accepted limitation — there is no
 * calendar-of-record in this codebase to fall back to, and VIX/FRED-series
 * uptime is otherwise the backbone every Compass input already depends on.
 *
 * Forward-fill is COMPUTATION-TIME ONLY. It never writes a fabricated
 * compass_inputs row — a filled value only ever exists inside the in-memory
 * `series` array this module returns, for exactly one classifier run, then
 * is discarded. This sidesteps the task's stop condition ("forward-fill
 * would require writing fabricated rows indistinguishable from real
 * observations") entirely: there is nothing to distinguish because nothing
 * is persisted.
 */

export interface DatedValue {
  date: Date;
  value: number;
}

export interface CleanSeriesResult {
  /**
   * One entry per reference-calendar date up to and including asOfDate,
   * forward-filled from the most recent real observation whenever the raw
   * series has no entry for that date. Observation-indexed lookbacks (e.g.
   * "5 observations back") should index into THIS array, not the raw
   * series — a filled entry counts as one observation.
   */
  series: DatedValue[];
  /** Most recent date with a REAL (non-filled) observation, or null if none. */
  latestRealDate: Date | null;
  /**
   * Reference-calendar trading days between latestRealDate and asOfDate
   * (0 if asOfDate itself has a real observation). Null if there is no real
   * observation at all in the lookback window.
   */
  staleTradingDays: number | null;
  /** staleTradingDays !== null && staleTradingDays > staleLimitTradingDays. */
  isStale: boolean;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build a forward-filled, observation-indexed series aligned to
 * `referenceCalendar` (ascending, deduplicated, <= asOfDate, and including
 * asOfDate if the reference series itself has an observation that day).
 *
 * `rawSeries` is the series actually being cleaned (ascending, real
 * observations only, <= asOfDate).
 */
export function buildCleanSeries(
  rawSeries: DatedValue[],
  referenceCalendar: Date[],
  asOfDate: Date,
  staleLimitTradingDays: number,
): CleanSeriesResult {
  const rawByDate = new Map<string, number>();
  for (const o of rawSeries) rawByDate.set(dateKey(o.date), o.value);

  const calendarUpToAsOf = referenceCalendar.filter((d) => d.getTime() <= asOfDate.getTime());
  // asOfDate must itself be represented even if the reference series lacks
  // an entry for it (e.g. reference fetch ran but hasn't posted today yet) —
  // otherwise staleness for "today" could never be measured.
  if (!calendarUpToAsOf.some((d) => d.getTime() === asOfDate.getTime())) {
    calendarUpToAsOf.push(asOfDate);
  }
  calendarUpToAsOf.sort((a, b) => a.getTime() - b.getTime());

  const series: DatedValue[] = [];
  let lastRealValue: number | null = null;
  let lastRealIndex: number | null = null;

  for (let i = 0; i < calendarUpToAsOf.length; i += 1) {
    const d = calendarUpToAsOf[i];
    const real = rawByDate.get(dateKey(d));
    if (real !== undefined) {
      lastRealValue = real;
      lastRealIndex = i;
      series.push({ date: d, value: real });
      continue;
    }
    if (lastRealValue !== null) {
      series.push({ date: d, value: lastRealValue });
    }
    // No real value yet at all — nothing to fill from; leave this slot absent.
  }

  if (lastRealIndex === null) {
    return { series, latestRealDate: null, staleTradingDays: null, isStale: false };
  }

  const latestRealDate = calendarUpToAsOf[lastRealIndex];
  const staleTradingDays = calendarUpToAsOf.length - 1 - lastRealIndex;
  const isStale = staleTradingDays > staleLimitTradingDays;

  return { series, latestRealDate, staleTradingDays, isStale };
}

/**
 * Observation-indexed lookback: value `n` observations back from the latest
 * entry in a cleaned series (which may include forward-filled values — they
 * count as observations). Returns null if the series has fewer than n+1
 * entries (insufficient history — caller must go YELLOW + flag, never
 * silently compute on a short window).
 */
export function obsChangeFromClean(series: DatedValue[], n: number): number | null {
  if (series.length < n + 1) return null;
  return series[series.length - 1].value - series[series.length - 1 - n].value;
}

/** Simple moving average over the last n entries of a cleaned series. Null if fewer than n entries exist. */
export function smaFromClean(series: DatedValue[], n: number): number | null {
  if (series.length < n) return null;
  const lastN = series.slice(-n);
  return lastN.reduce((sum, v) => sum + v.value, 0) / n;
}

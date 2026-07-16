import { describe, it, expect } from 'vitest';
import {
  buildCleanSeries,
  obsChangeFromClean,
  smaFromClean,
  type DatedValue,
} from '@modules/edgefinder/services/compass/compass-staleness';

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function weekdayCalendar(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

describe('buildCleanSeries', () => {
  it('[case 1] forward-fills a series missing D but present D-1 — the fill counts, not stale', () => {
    // Mon-Fri 2026-05-11..15, then Mon 2026-05-18 missing from raw (only D-1 present)
    const raw: DatedValue[] = [
      { date: d('2026-05-11'), value: 1 },
      { date: d('2026-05-12'), value: 2 },
      { date: d('2026-05-13'), value: 3 },
      { date: d('2026-05-14'), value: 4 },
      { date: d('2026-05-15'), value: 5 },
    ];
    const calendar = weekdayCalendar(d('2026-05-11'), d('2026-05-18'));
    const clean = buildCleanSeries(raw, calendar, d('2026-05-18'), 3);
    expect(clean.isStale).toBe(false);
    expect(clean.series.at(-1)?.value).toBe(5); // forward-filled from 05-15
    expect(clean.series.at(-1)?.date).toEqual(d('2026-05-18'));
  });

  it('[case 2] series missing D through D-2 (3 trading days), limit 3 — still filled, not stale', () => {
    // Real data ends 05-13 (Wed); 05-14, 05-15, 05-18 (Thu, Fri, Mon) are gaps = 3 trading days stale.
    const raw: DatedValue[] = [
      { date: d('2026-05-11'), value: 1 },
      { date: d('2026-05-12'), value: 2 },
      { date: d('2026-05-13'), value: 3 },
    ];
    const calendar = weekdayCalendar(d('2026-05-11'), d('2026-05-18'));
    const clean = buildCleanSeries(raw, calendar, d('2026-05-18'), 3);
    expect(clean.isStale).toBe(false);
    expect(clean.staleTradingDays).toBe(3);
    expect(clean.series.at(-1)?.value).toBe(3); // forward-filled from 05-13
  });

  it('[case 3] stale beyond the limit (4+ trading days, limit 3) — isStale true', () => {
    const raw: DatedValue[] = [
      { date: d('2026-05-08'), value: 1 },
      { date: d('2026-05-11'), value: 2 },
      { date: d('2026-05-12'), value: 3 },
    ];
    // Real data ends 05-12 (Tue); 05-13,14,15,18 = 4 trading days stale > limit 3.
    const calendar = weekdayCalendar(d('2026-05-08'), d('2026-05-18'));
    const clean = buildCleanSeries(raw, calendar, d('2026-05-18'), 3);
    expect(clean.isStale).toBe(true);
    expect(clean.staleTradingDays).toBe(4);
  });

  it('[case 4] forward-filled values COUNT as observations — calendar-based vs observation-based lookback diverge', () => {
    // Real data: 6 weekday observations, but with a 1-day gap in the middle
    // (05-13 missing). Observation-indexed "5 back" from 05-18 must count
    // the FILLED 05-13 slot as an observation, landing on 05-11 (value 10)
    // — NOT on whatever a naive calendar-day slice(-6) would pick.
    const raw: DatedValue[] = [
      { date: d('2026-05-11'), value: 10 },
      { date: d('2026-05-12'), value: 20 },
      // 2026-05-13 missing — forward-filled to 20
      { date: d('2026-05-14'), value: 30 },
      { date: d('2026-05-15'), value: 40 },
      { date: d('2026-05-18'), value: 50 },
    ];
    const calendar = weekdayCalendar(d('2026-05-11'), d('2026-05-18'));
    const clean = buildCleanSeries(raw, calendar, d('2026-05-18'), 3);
    // clean.series = [05-11:10, 05-12:20, 05-13:20(filled), 05-14:30, 05-15:40, 05-18:50]
    expect(clean.series).toHaveLength(6);
    const delta5 = obsChangeFromClean(clean.series, 5);
    expect(delta5).toBe(50 - 10); // 5 observations back from 05-18 (index 5) is 05-11 (index 0)
  });

  it('[case 7] insufficient history for a lookback (fewer observations than N) reports via short length, not a silent compute', () => {
    const raw: DatedValue[] = [
      { date: d('2026-05-14'), value: 1 },
      { date: d('2026-05-15'), value: 2 },
    ];
    const calendar = weekdayCalendar(d('2026-05-14'), d('2026-05-18'));
    const clean = buildCleanSeries(raw, calendar, d('2026-05-18'), 3);
    // Only 3 clean observations (05-14, 05-15, 05-18 filled) — asking for a
    // 5-back change must return null, never index out of range silently.
    expect(clean.series.length).toBeLessThan(6);
    expect(obsChangeFromClean(clean.series, 5)).toBeNull();
    expect(smaFromClean(clean.series, 10)).toBeNull();
  });

  it('no real observation at all → latestRealDate null, not stale (nothing to compare against)', () => {
    const clean = buildCleanSeries([], [d('2026-05-18')], d('2026-05-18'), 3);
    expect(clean.latestRealDate).toBeNull();
    expect(clean.isStale).toBe(false);
    expect(clean.series).toHaveLength(0);
  });

  it('real observation exactly on asOfDate → zero staleness, not filled', () => {
    const raw: DatedValue[] = [{ date: d('2026-05-18'), value: 99 }];
    const clean = buildCleanSeries(raw, [d('2026-05-18')], d('2026-05-18'), 3);
    expect(clean.staleTradingDays).toBe(0);
    expect(clean.isStale).toBe(false);
    expect(clean.series.at(-1)?.value).toBe(99);
  });
});

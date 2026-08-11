import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ForexFactoryEvent } from '@core/clients/forex-factory/types';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    indicator: { findMany: vi.fn() },
    dataPoint: { findFirst: vi.fn() },
  },
}));

// B3: every event is now stored in calendar_events before any scoring
// decision, so the ingest loop touches this repository once per event.
vi.mock('@core/repositories/calendar-events.repository', () => ({
  calendarEventsRepository: {
    upsert: vi.fn(),
  },
}));

vi.mock('@core/clients/forex-factory/forex-factory.client', () => ({
  forexFactoryClient: { getCalendarWeek: vi.fn() },
}));

vi.mock('@core/repositories/data-points.repository', () => ({
  dataPointsRepository: {
    upsert: vi.fn(),
  },
}));

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: {
    start: vi.fn(),
    complete: vi.fn(),
  },
}));

import { prisma } from '@core/db/prisma';
import { forexFactoryClient } from '@core/clients/forex-factory/forex-factory.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { calendarEventsRepository } from '@core/repositories/calendar-events.repository';
import {
  detectMissingValues,
  parseForexFactoryDate,
  parseForexFactoryInstant,
  fetchForexFactoryWeek,
  resolveRunStatus,
  collapseNearDuplicates,
} from '@modules/edgefinder/services/forex-factory-indicator.service';

const mockedFindMany = prisma.indicator.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedGetCalendar = forexFactoryClient.getCalendarWeek as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = dataPointsRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedLogStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedLogComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;
const mockedCalendarUpsert = calendarEventsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

function makeEvent(partial: Partial<ForexFactoryEvent>): ForexFactoryEvent {
  const base: ForexFactoryEvent = {
    title: partial.title ?? 'CPI y/y',
    country: partial.country ?? 'USD',
    date: partial.date ?? '2026-05-12T12:30:00-04:00',
    impact: partial.impact ?? 'High',
    forecast: partial.forecast ?? '',
    previous: partial.previous ?? '',
  };
  if ('actual' in partial) {
    base.actual = partial.actual;
  }
  if (partial.url !== undefined) base.url = partial.url;
  return base;
}

describe('detectMissingValues (Forex Factory)', () => {
  // B1 — the discard bug. A missing `actual` now means only "no score can be
  // computed"; forecast and previous survive and the event is still stored.
  // The old behaviour nulled all three, which mattered enormously in practice:
  // the feed is a forward schedule that omits `actual` entirely on unreleased
  // events, so every event took this branch and the pipeline wrote nothing.

  it('defers scoring when actual is undefined, but RETAINS forecast/previous', () => {
    const ev = makeEvent({ forecast: '3.5%', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.noActualYet).toBe(true);
    expect(result.actual).toBeNull();
    expect(result.forecast).toBe(3.5);
    expect(result.previous).toBe(3.2);
  });

  it('defers scoring when actual is empty string, but RETAINS forecast/previous', () => {
    const ev = makeEvent({ actual: '', forecast: '3.5%', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.noActualYet).toBe(true);
    expect(result.forecast).toBe(3.5);
    expect(result.previous).toBe(3.2);
  });

  it('parses all three values when all present', () => {
    const ev = makeEvent({ actual: '3.4%', forecast: '3.5%', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.noActualYet).toBe(false);
    expect(result.actual).toBe(3.4);
    expect(result.forecast).toBe(3.5);
    expect(result.previous).toBe(3.2);
  });

  it('handles empty forecast but valid actual', () => {
    const ev = makeEvent({ actual: '3.4%', forecast: '', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.noActualYet).toBe(false);
    expect(result.actual).toBe(3.4);
    expect(result.forecast).toBeNull();
    expect(result.previous).toBe(3.2);
  });

  it('defers scoring when actual is unparseable, but RETAINS forecast/previous', () => {
    const ev = makeEvent({ actual: 'abc', forecast: '3.5%', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.noActualYet).toBe(true);
    expect(result.actual).toBeNull();
    expect(result.forecast).toBe(3.5);
  });
});

describe('B2: resolveRunStatus', () => {
  const base = {
    totalEvents: 99,
    calendarRowsWritten: 99,
    mappedCount: 18,
    unmappedCount: 81,
    mappedDeferredCount: 5,
    errorCount: 0,
  };

  it('FAILS a run that stored nothing — the exact historical bug shape', () => {
    // Five consecutive real cron runs reported success with these numbers
    // while writing zero rows and leaving the database empty.
    expect(
      resolveRunStatus({
        totalEvents: 99,
        calendarRowsWritten: 0,
        mappedCount: 15,
        unmappedCount: 84,
        mappedDeferredCount: 15,
        errorCount: 0,
      }),
    ).toBe('failed');
  });

  it('fails on an empty feed', () => {
    expect(resolveRunStatus({ ...base, totalEvents: 0, calendarRowsWritten: 0, mappedCount: 0 })).toBe('failed');
  });

  it('fails when nothing mapped at all (wholesale upstream drift)', () => {
    expect(resolveRunStatus({ ...base, mappedCount: 0, mappedDeferredCount: 0 })).toBe('failed');
  });

  it('is partial when errors occurred mid-run', () => {
    expect(resolveRunStatus({ ...base, errorCount: 3 })).toBe('partial');
  });

  it('is partial when every mapped event was deferred', () => {
    expect(resolveRunStatus({ ...base, mappedDeferredCount: base.mappedCount })).toBe('partial');
  });

  it('succeeds on a healthy run', () => {
    expect(resolveRunStatus(base)).toBe('success');
  });

  it('does NOT degrade a healthy run merely because unmapped events exist', () => {
    // ~80 unmapped events a week is normal: untracked releases, bond
    // auctions, Fed speakers, and the deliberately-excluded sub-PMIs.
    expect(resolveRunStatus({ ...base, unmappedCount: 81, mappedDeferredCount: 0 })).toBe('success');
  });
});

describe('parseForexFactoryInstant', () => {
  it('converts the feed offset to the correct UTC instant', () => {
    // B3 stores the absolute instant, never a local-time string.
    expect(parseForexFactoryInstant('2026-08-02T21:45:00-04:00').toISOString()).toBe(
      '2026-08-03T01:45:00.000Z',
    );
    expect(parseForexFactoryInstant('2026-05-21T08:30:00-04:00').toISOString()).toBe(
      '2026-05-21T12:30:00.000Z',
    );
  });

  it('throws on invalid date strings', () => {
    expect(() => parseForexFactoryInstant('not a date')).toThrow();
  });
});

describe('parseForexFactoryDate', () => {
  it('parses ISO 8601 with timezone offset into UTC midnight', () => {
    const parsed = parseForexFactoryDate('2026-05-21T08:30:00-04:00');
    expect(parsed.toISOString()).toBe('2026-05-21T00:00:00.000Z');
  });

  it('throws on invalid date strings', () => {
    expect(() => parseForexFactoryDate('not a date')).toThrow();
  });
});

describe('fetchForexFactoryWeek', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLogStart.mockResolvedValue({ id: 'log-1' });
    mockedLogComplete.mockResolvedValue(undefined);
    mockedFindFirst.mockResolvedValue(null);
    // Every event now goes through calendar storage first (B3).
    mockedCalendarUpsert.mockResolvedValue({ action: 'inserted', event: {} });
  });

  it('upserts a mapped regular event with parsed actual/forecast/previous', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'CPI y/y',
          country: 'USD',
          actual: '3.4%',
          forecast: '3.5%',
          previous: '3.2%',
          date: '2026-05-12T12:30:00-04:00',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 100,
    });
    mockedFindMany.mockResolvedValue([{ id: 'ind-cpi', code: 'US_CPI_YOY' }]);
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    const result = await fetchForexFactoryWeek('manual', null);

    expect(result.status).toBe('success');
    expect(result.mappedCount).toBe(1);
    expect(result.mappedDeferredCount).toBe(0);
    expect(result.rowsInserted).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    expect(mockedUpsert).toHaveBeenCalledTimes(1);

    const call = mockedUpsert.mock.calls[0][0];
    expect(call.indicatorId).toBe('ind-cpi');
    expect((call.observationDate as Date).toISOString()).toBe('2026-05-12T00:00:00.000Z');
    expect(call.value).toBe(3.4);
    expect(call.forecastValue).toBe(3.5);
    expect(call.previousValue).toBe(3.2);
    expect(call.source).toBe('forex_factory');
  });

  it('logs and counts unmapped events without upserting', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'Mystery Speech',
          country: 'USD',
          actual: '1',
          forecast: '1',
          previous: '1',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 50,
    });
    mockedFindMany.mockResolvedValue([]);

    const result = await fetchForexFactoryWeek('manual', null);

    expect(result.unmappedCount).toBe(1);
    expect(result.mappedCount).toBe(0);
    expect(result.mappedDeferredCount).toBe(0);
    expect(result.unmappedEvents).toEqual([{ title: 'Mystery Speech', country: 'USD' }]);
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('mapped event with undefined actual → mappedCount++, mappedDeferredCount++, no upsert', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'CPI y/y',
          country: 'GBP',
          forecast: '3.5%',
          previous: '3.2%',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 50,
    });
    mockedFindMany.mockResolvedValue([{ id: 'ind-uk-cpi', code: 'UK_CPI_YOY' }]);

    const result = await fetchForexFactoryWeek('manual', null);

    expect(result.mappedCount).toBe(1);
    expect(result.mappedDeferredCount).toBe(1);
    expect(result.unmappedCount).toBe(0);
    expect(result.rowsInserted).toBe(0);
    expect(result.rowsUpdated).toBe(0);
    expect(result.rowsSkipped).toBe(0);
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('mapped event with undefined actual is deferred not skipped', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'CPI y/y',
          country: 'USD',
          forecast: '3.5%',
          previous: '3.2%',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 50,
    });
    mockedFindMany.mockResolvedValue([{ id: 'ind-cpi', code: 'US_CPI_YOY' }]);

    const result = await fetchForexFactoryWeek('manual', null);

    expect(result.mappedCount).toBe(1);
    expect(result.mappedDeferredCount).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('mapped event with empty-string actual is deferred not skipped', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'CPI y/y',
          country: 'USD',
          actual: '',
          forecast: '3.5%',
          previous: '3.2%',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 50,
    });
    mockedFindMany.mockResolvedValue([{ id: 'ind-cpi', code: 'US_CPI_YOY' }]);

    const result = await fetchForexFactoryWeek('manual', null);

    expect(result.mappedCount).toBe(1);
    expect(result.mappedDeferredCount).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('rate decision with prior rate computes bps_change correctly, and forecast (expected level) as a matching bps delta', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'Federal Funds Rate',
          country: 'USD',
          actual: '5.25%',
          forecast: '5.25%',
          previous: '5.00%',
          date: '2026-05-14T18:00:00-04:00',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 50,
    });
    mockedFindMany.mockResolvedValue([{ id: 'ind-fed', code: 'US_FED_RATE' }]);
    mockedFindFirst.mockResolvedValue({ sourceMetadata: { rate_level: 5.0 } });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    const result = await fetchForexFactoryWeek('manual', null);

    expect(result.rowsInserted).toBe(1);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.value).toBeCloseTo(25, 6);
    // Change 2 Step 1: forecast ('5.25%', an expected absolute rate level) is
    // converted to a bps-change delta against the SAME priorRate (5.0) as
    // value — same unit, so an "as expected" 25bp hike stores forecastValue
    // = 25 (matching value = 25), which is what lets the handler score it 0.
    expect(call.forecastValue).toBeCloseTo(25, 6);
    expect((call.sourceMetadata as Record<string, unknown>).rate_level).toBe(5.25);
    expect((call.sourceMetadata as Record<string, unknown>).expected_rate_level).toBe(5.25);
    expect((call.sourceMetadata as Record<string, unknown>).first_release).toBeUndefined();
  });

  it('rate decision with no prior data stores bps_change=0, first_release=true, and forecastValue null (no baseline to convert against)', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'Federal Funds Rate',
          country: 'USD',
          actual: '5.25%',
          forecast: '5.25%',
          previous: '5.00%',
          date: '2026-05-14T18:00:00-04:00',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 50,
    });
    mockedFindMany.mockResolvedValue([{ id: 'ind-fed', code: 'US_FED_RATE' }]);
    mockedFindFirst.mockResolvedValue(null);
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    await fetchForexFactoryWeek('manual', null);

    const call = mockedUpsert.mock.calls[0][0];
    expect(call.value).toBe(0);
    expect(call.forecastValue).toBeNull();
    expect((call.sourceMetadata as Record<string, unknown>).rate_level).toBe(5.25);
    expect((call.sourceMetadata as Record<string, unknown>).first_release).toBe(true);
  });
});

describe('collapseNearDuplicates — Fix 2: in-fetch near-duplicate collapse', () => {
  // The exact live case: identical title, identical country, 60 seconds
  // apart, one placeholder (no previous/forecast) and one real row. Uses the
  // real historically-observed title string ("ADP Weekly Employment
  // Change") — collapseNearDuplicates operates on raw feed rows only and
  // has no dependency on the mapping table, so this stays a faithful
  // regression case even though that title no longer resolves to an
  // indicator (see the mapping table's own "deliberately not mapped" fix).
  it('collapses the observed feed pair (60s apart) to the row carrying previousRaw', () => {
    const placeholder = makeEvent({
      title: 'ADP Weekly Employment Change',
      country: 'USD',
      date: '2026-08-11T08:15:00-04:00',
      forecast: '',
      previous: '',
    });
    const real = makeEvent({
      title: 'ADP Weekly Employment Change',
      country: 'USD',
      date: '2026-08-11T08:16:00-04:00',
      forecast: '',
      previous: '15.0K',
    });

    const result = collapseNearDuplicates([placeholder, real]);

    expect(result).toHaveLength(1);
    expect(result[0].previous).toBe('15.0K');
    expect(result[0].date).toBe('2026-08-11T08:16:00-04:00');
  });

  it('collapses regardless of feed order (real row first, placeholder second)', () => {
    const real = makeEvent({
      title: 'ADP Weekly Employment Change',
      country: 'USD',
      date: '2026-08-11T08:16:00-04:00',
      previous: '15.0K',
    });
    const placeholder = makeEvent({
      title: 'ADP Weekly Employment Change',
      country: 'USD',
      date: '2026-08-11T08:15:00-04:00',
      previous: '',
    });

    const result = collapseNearDuplicates([real, placeholder]);

    expect(result).toHaveLength(1);
    expect(result[0].previous).toBe('15.0K');
  });

  it('does NOT collapse a genuine reschedule — same title, hours apart', () => {
    const original = makeEvent({
      title: 'Core CPI m/m',
      country: 'USD',
      date: '2026-08-12T08:30:00-04:00',
      previous: '0.2%',
    });
    const rescheduled = makeEvent({
      title: 'Core CPI m/m',
      country: 'USD',
      date: '2026-08-12T14:30:00-04:00', // 6 hours later — a real reschedule
      previous: '0.2%',
    });

    const result = collapseNearDuplicates([original, rescheduled]);

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.date)).toEqual([
      '2026-08-12T08:30:00-04:00',
      '2026-08-12T14:30:00-04:00',
    ]);
  });

  it('does NOT collapse two events exactly at the 5-minute boundary plus one second', () => {
    // Window is <=5min INCLUSIVE at exactly 5:00, so use 5:01 to land
    // unambiguously outside it and assert the boundary is respected, not
    // just "approximately 5 minutes."
    const first = makeEvent({
      title: 'Retail Sales m/m',
      country: 'USD',
      date: '2026-08-14T08:30:00-04:00',
    });
    const second = makeEvent({
      title: 'Retail Sales m/m',
      country: 'USD',
      date: '2026-08-14T08:35:01-04:00', // 5 min 1 sec later
    });

    const result = collapseNearDuplicates([first, second]);
    expect(result).toHaveLength(2);
  });

  it('DOES collapse two events exactly at the 5-minute boundary (inclusive)', () => {
    const first = makeEvent({
      title: 'Retail Sales m/m',
      country: 'USD',
      date: '2026-08-14T08:30:00-04:00',
      previous: '',
    });
    const second = makeEvent({
      title: 'Retail Sales m/m',
      country: 'USD',
      date: '2026-08-14T08:35:00-04:00', // exactly 5 min later
      previous: '0.1%',
    });

    const result = collapseNearDuplicates([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].previous).toBe('0.1%');
  });

  // THE companion-interaction check the user asked to be verified, not
  // assumed: AU_RBA_RATE's "Cash Rate" and "RBA Rate Statement" share an
  // exact instant but are DIFFERENT titles. collapseNearDuplicates groups by
  // (country, title) — an exact string match — so these must never merge,
  // which would silently undo the Fix 1 companion designation.
  it('does NOT collapse AU_RBA_RATE companion pair despite sharing the exact same instant', () => {
    const cashRate = makeEvent({
      title: 'Cash Rate',
      country: 'AUD',
      date: '2026-08-11T00:30:00-04:00',
      forecast: '4.35%',
      previous: '4.35%',
    });
    const rateStatement = makeEvent({
      title: 'RBA Rate Statement',
      country: 'AUD',
      date: '2026-08-11T00:30:00-04:00', // identical instant
      forecast: '',
      previous: '',
    });

    const result = collapseNearDuplicates([cashRate, rateStatement]);

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.title).sort()).toEqual(['Cash Rate', 'RBA Rate Statement']);
  });

  it('does not collapse across different countries with the same title', () => {
    const usdEvent = makeEvent({ title: 'CPI y/y', country: 'USD', date: '2026-08-12T08:30:00-04:00' });
    const gbpEvent = makeEvent({ title: 'CPI y/y', country: 'GBP', date: '2026-08-12T08:31:00-04:00' });

    const result = collapseNearDuplicates([usdEvent, gbpEvent]);
    expect(result).toHaveLength(2);
  });

  it('is a no-op on a feed with no duplicates', () => {
    const events = [
      makeEvent({ title: 'CPI y/y', country: 'USD', date: '2026-08-12T08:30:00-04:00' }),
      makeEvent({ title: 'PPI m/m', country: 'USD', date: '2026-08-13T08:30:00-04:00' }),
    ];
    const result = collapseNearDuplicates(events);
    expect(result).toHaveLength(2);
  });

  it('falls back to the latest instant when neither row in a cluster has populated fields', () => {
    const first = makeEvent({
      title: 'FOMC Member Hammack Speaks',
      country: 'USD',
      date: '2026-08-10T15:00:00-04:00',
      forecast: '',
      previous: '',
    });
    const second = makeEvent({
      title: 'FOMC Member Hammack Speaks',
      country: 'USD',
      date: '2026-08-10T15:01:00-04:00',
      forecast: '',
      previous: '',
    });

    const result = collapseNearDuplicates([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-08-10T15:01:00-04:00'); // latest wins
  });
});

describe('fetchForexFactoryWeek — Fix 2: collapse runs before the per-event upsert loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLogStart.mockResolvedValue({ id: 'log-1' });
    mockedLogComplete.mockResolvedValue(undefined);
    mockedFindFirst.mockResolvedValue(null);
    mockedCalendarUpsert.mockResolvedValue({ action: 'inserted', event: {} });
  });

  it('a mapped placeholder/real pair (ADP Non-Farm Employment Change) reaches calendarEventsRepository.upsert exactly ONCE', async () => {
    // Uses the MONTHLY title (still mapped to US_ADP) so this test exercises
    // collapse-before-upsert on a title that actually resolves to an
    // indicator — the weekly title used to be the live example of this but
    // is now deliberately unmapped (see the mapping table fix), so it no
    // longer demonstrates the mapped-path collapse behaviour this test
    // targets.
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'ADP Non-Farm Employment Change',
          country: 'USD',
          date: '2026-08-05T08:15:00-04:00',
          forecast: '',
          previous: '',
        }),
        makeEvent({
          title: 'ADP Non-Farm Employment Change',
          country: 'USD',
          date: '2026-08-05T08:16:00-04:00',
          forecast: '',
          previous: '98K',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 100,
    });
    mockedFindMany.mockResolvedValue([{ id: 'ind-adp', code: 'US_ADP' }]);

    const result = await fetchForexFactoryWeek('manual', null);

    // totalEvents reports the RAW feed count — telemetry about what FF sent,
    // not about how many occurrences got written (see the doc in
    // fetchForexFactoryWeek on this).
    expect(result.totalEvents).toBe(2);
    expect(mockedCalendarUpsert).toHaveBeenCalledTimes(1);
    const call = mockedCalendarUpsert.mock.calls[0][0];
    expect(call.previousRaw).toBe('98K');
    expect(call.title).toBe('ADP Non-Farm Employment Change');
    expect(call.indicatorCode).toBe('US_ADP');
  });

  it('a near-duplicate pair of the (now unmapped) weekly ADP title still collapses to one row, unmapped', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'ADP Weekly Employment Change',
          country: 'USD',
          date: '2026-08-11T08:15:00-04:00',
          forecast: '',
          previous: '',
        }),
        makeEvent({
          title: 'ADP Weekly Employment Change',
          country: 'USD',
          date: '2026-08-11T08:16:00-04:00',
          forecast: '',
          previous: '15.0K',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 100,
    });
    mockedFindMany.mockResolvedValue([]); // nothing mapped this fetch

    const result = await fetchForexFactoryWeek('manual', null);

    expect(mockedCalendarUpsert).toHaveBeenCalledTimes(1);
    const call = mockedCalendarUpsert.mock.calls[0][0];
    expect(call.previousRaw).toBe('15.0K');
    expect(call.indicatorCode).toBeNull();
    expect(call.isPrimary).toBe(true); // unmapped rows are always primary
    expect(result.unmappedCount).toBe(1);
  });

  it('a genuinely rescheduled event (hours apart) still reaches upsert TWICE', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'Core CPI m/m',
          country: 'USD',
          date: '2026-08-12T08:30:00-04:00',
        }),
        makeEvent({
          title: 'Core CPI m/m',
          country: 'USD',
          date: '2026-08-12T14:30:00-04:00',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 100,
    });
    mockedFindMany.mockResolvedValue([]);

    await fetchForexFactoryWeek('manual', null);

    expect(mockedCalendarUpsert).toHaveBeenCalledTimes(2);
  });

  it('AU_RBA_RATE companion pair (same instant, different titles) both reach upsert with correct isPrimary', async () => {
    mockedGetCalendar.mockResolvedValue({
      events: [
        makeEvent({
          title: 'Cash Rate',
          country: 'AUD',
          date: '2026-08-11T00:30:00-04:00',
          forecast: '4.35%',
          previous: '4.35%',
        }),
        makeEvent({
          title: 'RBA Rate Statement',
          country: 'AUD',
          date: '2026-08-11T00:30:00-04:00',
        }),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
      responseSizeBytes: 100,
    });
    mockedFindMany.mockResolvedValue([{ id: 'ind-rba', code: 'AU_RBA_RATE' }]);

    await fetchForexFactoryWeek('manual', null);

    expect(mockedCalendarUpsert).toHaveBeenCalledTimes(2);
    const calls = mockedCalendarUpsert.mock.calls.map((c) => c[0]);
    const cashRateCall = calls.find((c) => c.title === 'Cash Rate');
    const statementCall = calls.find((c) => c.title === 'RBA Rate Statement');
    expect(cashRateCall.isPrimary).toBe(true);
    expect(statementCall.isPrimary).toBe(false);
  });
});

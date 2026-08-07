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

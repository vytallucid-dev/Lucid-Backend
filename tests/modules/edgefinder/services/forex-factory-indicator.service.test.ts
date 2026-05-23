import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ForexFactoryEvent } from '@core/clients/forex-factory/types';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    indicator: { findMany: vi.fn() },
    dataPoint: { findFirst: vi.fn() },
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
import {
  detectMissingValues,
  parseForexFactoryDate,
  fetchForexFactoryWeek,
} from '@modules/edgefinder/services/forex-factory-indicator.service';

const mockedFindMany = prisma.indicator.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedGetCalendar = forexFactoryClient.getCalendarWeek as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = dataPointsRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedLogStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedLogComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;

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
  it('skips entire event when actual is undefined (future release)', () => {
    const ev = makeEvent({ forecast: '3.5%', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.skipEntireEvent).toBe(true);
  });

  it('skips entire event when actual is empty string', () => {
    const ev = makeEvent({ actual: '', forecast: '3.5%', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.skipEntireEvent).toBe(true);
  });

  it('parses all three values when all present', () => {
    const ev = makeEvent({ actual: '3.4%', forecast: '3.5%', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.skipEntireEvent).toBe(false);
    expect(result.actual).toBe(3.4);
    expect(result.forecast).toBe(3.5);
    expect(result.previous).toBe(3.2);
  });

  it('handles empty forecast but valid actual', () => {
    const ev = makeEvent({ actual: '3.4%', forecast: '', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.skipEntireEvent).toBe(false);
    expect(result.actual).toBe(3.4);
    expect(result.forecast).toBeNull();
    expect(result.previous).toBe(3.2);
  });

  it('skips when actual is unparseable', () => {
    const ev = makeEvent({ actual: 'abc', forecast: '3.5%', previous: '3.2%' });
    const result = detectMissingValues(ev);
    expect(result.skipEntireEvent).toBe(true);
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

  it('rate decision with prior rate computes bps_change correctly', async () => {
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
    expect(call.forecastValue).toBeNull();
    expect((call.sourceMetadata as Record<string, unknown>).rate_level).toBe(5.25);
    expect((call.sourceMetadata as Record<string, unknown>).first_release).toBeUndefined();
  });

  it('rate decision with no prior data stores bps_change=0 and first_release=true', async () => {
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
    expect((call.sourceMetadata as Record<string, unknown>).rate_level).toBe(5.25);
    expect((call.sourceMetadata as Record<string, unknown>).first_release).toBe(true);
  });
});

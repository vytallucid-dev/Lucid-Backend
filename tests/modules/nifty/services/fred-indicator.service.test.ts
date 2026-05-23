import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    indicator: { findUnique: vi.fn(), findMany: vi.fn() },
    dataPoint: { findFirst: vi.fn() },
  },
}));

vi.mock('@core/clients/fred/fred.client', () => ({
  fredClient: { getSeriesObservations: vi.fn() },
}));

vi.mock('@core/repositories/data-points.repository', () => ({
  dataPointsRepository: {
    upsert: vi.fn(),
    getLatestObservationDate: vi.fn(),
  },
}));

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: {
    start: vi.fn(),
    complete: vi.fn(),
  },
}));

import { prisma } from '@core/db/prisma';
import { fredClient } from '@core/clients/fred/fred.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { fetchFredIndicator } from '@modules/nifty/services/fred-indicator.service';

const mockedFindUnique = prisma.indicator.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedGetSeries = fredClient.getSeriesObservations as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = dataPointsRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedGetLatest = dataPointsRepository.getLatestObservationDate as unknown as ReturnType<typeof vi.fn>;
const mockedLogStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedLogComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;

function makeIndicator(code: string, seriesId: string): unknown {
  return {
    id: `ind-${code}`,
    code,
    name: code,
    dataSource: 'fred',
    sourceSeriesId: seriesId,
    isActive: true,
  };
}

function obs(date: string, value: string): {
  realtime_start: string;
  realtime_end: string;
  date: string;
  value: string;
} {
  return {
    realtime_start: '2026-05-15',
    realtime_end: '2026-05-15',
    date,
    value,
  };
}

function setupCommon(code: string, seriesId: string): void {
  mockedFindUnique.mockResolvedValue(makeIndicator(code, seriesId));
  mockedGetLatest.mockResolvedValue(null);
  mockedLogStart.mockResolvedValue({ id: 'log-1' });
  mockedLogComplete.mockResolvedValue(undefined);
}

describe('fetchFredIndicator — generic path previous_value chaining', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first batch, empty DB: first row prev=null, subsequent rows chain', async () => {
    setupCommon('USA_CPI', 'CPIAUCSL');
    mockedFindFirst.mockResolvedValueOnce(null); // no prior in DB
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'CPIAUCSL',
      observations: [
        obs('2026-01-01', '100.0'),
        obs('2026-02-01', '101.5'),
        obs('2026-03-01', '102.3'),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    const result = await fetchFredIndicator({
      indicatorCode: 'USA_CPI',
      triggerType: 'manual',
    });

    expect(result.status).toBe('success');
    expect(mockedUpsert).toHaveBeenCalledTimes(3);
    expect(mockedUpsert.mock.calls[0][0].previousValue).toBeNull();
    expect(mockedUpsert.mock.calls[1][0].previousValue).toBe(100.0);
    expect(mockedUpsert.mock.calls[2][0].previousValue).toBe(101.5);
    // forecastValue stays null on FRED path
    for (const call of mockedUpsert.mock.calls) {
      expect(call[0].forecastValue).toBeNull();
    }
  });

  it('subsequent batch with DB prior: first row chains from DB prior', async () => {
    setupCommon('USA_CPI', 'CPIAUCSL');
    mockedFindFirst.mockResolvedValueOnce({ value: 99.4 }); // DB prior at D-1
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'CPIAUCSL',
      observations: [obs('2026-04-01', '103.1'), obs('2026-05-01', '104.0')],
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    await fetchFredIndicator({ indicatorCode: 'USA_CPI', triggerType: 'manual' });

    expect(mockedUpsert.mock.calls[0][0].previousValue).toBe(99.4);
    expect(mockedUpsert.mock.calls[1][0].previousValue).toBe(103.1);
  });

  it('FRED "." value mid-batch does not advance lastSeenValue', async () => {
    setupCommon('USA_CPI', 'CPIAUCSL');
    mockedFindFirst.mockResolvedValueOnce(null);
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'CPIAUCSL',
      observations: [
        obs('2026-01-01', '100.0'),
        obs('2026-02-01', '.'), // missing
        obs('2026-03-01', '102.3'),
      ],
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    const result = await fetchFredIndicator({
      indicatorCode: 'USA_CPI',
      triggerType: 'manual',
    });

    expect(mockedUpsert).toHaveBeenCalledTimes(2);
    // First obs: 100.0, prev null
    expect(mockedUpsert.mock.calls[0][0].value).toBe(100.0);
    expect(mockedUpsert.mock.calls[0][0].previousValue).toBeNull();
    // Third obs (after skip): 102.3, prev still 100.0 (not the missing one)
    expect(mockedUpsert.mock.calls[1][0].value).toBe(102.3);
    expect(mockedUpsert.mock.calls[1][0].previousValue).toBe(100.0);
    // The "." obs counts as a skip in the result
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsInserted).toBe(2);
  });

  it('idempotent re-run: all-skipped data yields zero inserts/revisions', async () => {
    setupCommon('USA_CPI', 'CPIAUCSL');
    mockedFindFirst.mockResolvedValueOnce({ value: 99.4 });
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'CPIAUCSL',
      observations: [obs('2026-01-01', '100.0'), obs('2026-02-01', '101.5')],
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert.mockResolvedValue({ action: 'skipped', dataPoint: null });

    const r = await fetchFredIndicator({ indicatorCode: 'USA_CPI', triggerType: 'manual' });

    expect(r.rowsInserted).toBe(0);
    expect(r.rowsUpdated).toBe(0);
    expect(r.rowsSkipped).toBe(2);
  });

  it('value-changed re-run: one revision counted', async () => {
    setupCommon('USA_CPI', 'CPIAUCSL');
    mockedFindFirst.mockResolvedValueOnce({ value: 99.4 });
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'CPIAUCSL',
      observations: [obs('2026-01-01', '100.0'), obs('2026-02-01', '101.5')],
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert
      .mockResolvedValueOnce({ action: 'skipped', dataPoint: null })
      .mockResolvedValueOnce({ action: 'revised', dataPoint: null });

    const r = await fetchFredIndicator({ indicatorCode: 'USA_CPI', triggerType: 'manual' });

    expect(r.rowsInserted).toBe(0);
    expect(r.rowsUpdated).toBe(1);
    expect(r.rowsSkipped).toBe(1);
  });

  it('first run after deploy: existing rows backfilled get revised once', async () => {
    setupCommon('USA_CPI', 'CPIAUCSL');
    mockedFindFirst.mockResolvedValueOnce({ value: 99.4 });
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'CPIAUCSL',
      observations: [obs('2026-01-01', '100.0'), obs('2026-02-01', '101.5')],
      requestUrl: '',
      fetchedAt: new Date(),
    });
    // Simulate repo deciding both rows need revision because previous_value
    // was previously NULL and is now being backfilled.
    mockedUpsert.mockResolvedValue({ action: 'revised', dataPoint: null });

    const r = await fetchFredIndicator({ indicatorCode: 'USA_CPI', triggerType: 'manual' });

    expect(r.rowsUpdated).toBe(2);
    expect(r.rowsInserted).toBe(0);
    // Confirm previousValue is being passed (the input that drives backfill).
    expect(mockedUpsert.mock.calls[0][0].previousValue).toBe(99.4);
    expect(mockedUpsert.mock.calls[1][0].previousValue).toBe(100.0);
  });
});

describe('fetchFredIndicator — US_02Y_SMA transform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes correct 21-day rolling SMA over raw DGS2 yields', async () => {
    setupCommon('US_02Y_SMA', 'DGS2');
    mockedFindFirst.mockResolvedValueOnce(null); // no DB prior

    // 25 raw observations, all within the lookback window (extendedDateFrom..dateTo).
    // Use easy-to-compute values: 1, 2, 3, ..., 25.
    const raw: ReturnType<typeof obs>[] = [];
    for (let i = 1; i <= 25; i++) {
      const d = new Date('2026-04-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + (i - 1));
      raw.push(obs(d.toISOString().slice(0, 10), String(i)));
    }
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'DGS2',
      observations: raw,
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    // Pass an explicit dateFrom = the first raw date, so ALL eligible SMAs persist
    // (indices 20..24 → SMAs of 1..21, 2..22, ..., 5..25).
    await fetchFredIndicator({
      indicatorCode: 'US_02Y_SMA',
      triggerType: 'manual',
      dateFrom: new Date('2026-04-01T00:00:00Z'),
      dateTo: new Date('2026-04-25T00:00:00Z'),
    });

    expect(mockedUpsert).toHaveBeenCalledTimes(5);
    const expectedSmas = [
      (1 + 21) / 2, // mean of 1..21 = 11
      (2 + 22) / 2, // 12
      (3 + 23) / 2, // 13
      (4 + 24) / 2, // 14
      (5 + 25) / 2, // 15
    ];
    for (let i = 0; i < 5; i++) {
      expect(mockedUpsert.mock.calls[i][0].value).toBeCloseTo(expectedSmas[i], 9);
    }
    // Stored value is the SMA, NOT the raw yield (raw yield on day 21 would be 21).
    expect(mockedUpsert.mock.calls[0][0].value).toBeCloseTo(11, 9);
    expect(mockedUpsert.mock.calls[0][0].value).not.toBe(21);
  });

  it('skips days with insufficient lookback (only 15 raw days → no SMA rows)', async () => {
    setupCommon('US_02Y_SMA', 'DGS2');
    mockedFindFirst.mockResolvedValueOnce(null);

    const raw: ReturnType<typeof obs>[] = [];
    for (let i = 1; i <= 15; i++) {
      const d = new Date('2026-04-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + (i - 1));
      raw.push(obs(d.toISOString().slice(0, 10), String(i)));
    }
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'DGS2',
      observations: raw,
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    await fetchFredIndicator({
      indicatorCode: 'US_02Y_SMA',
      triggerType: 'manual',
      dateFrom: new Date('2026-04-01T00:00:00Z'),
      dateTo: new Date('2026-04-15T00:00:00Z'),
    });

    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('sourceMetadata records seriesId=DGS2, windowDays=21', async () => {
    setupCommon('US_02Y_SMA', 'DGS2');
    mockedFindFirst.mockResolvedValueOnce(null);

    const raw: ReturnType<typeof obs>[] = [];
    for (let i = 1; i <= 22; i++) {
      const d = new Date('2026-04-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + (i - 1));
      raw.push(obs(d.toISOString().slice(0, 10), String(i)));
    }
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'DGS2',
      observations: raw,
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    await fetchFredIndicator({
      indicatorCode: 'US_02Y_SMA',
      triggerType: 'manual',
      dateFrom: new Date('2026-04-01T00:00:00Z'),
      dateTo: new Date('2026-04-22T00:00:00Z'),
    });

    expect(mockedUpsert).toHaveBeenCalled();
    const meta = mockedUpsert.mock.calls[0][0].sourceMetadata;
    expect(meta.seriesId).toBe('DGS2');
    expect(meta.windowDays).toBe(21);
    expect(meta.rawDataPointsUsed).toBe(21);
    expect(meta.rawDateRange).toEqual(['2026-04-01', '2026-04-22']);
  });

  it('previous_value chains across consecutive SMA values', async () => {
    setupCommon('US_02Y_SMA', 'DGS2');
    mockedFindFirst.mockResolvedValueOnce(null);

    const raw: ReturnType<typeof obs>[] = [];
    for (let i = 1; i <= 23; i++) {
      const d = new Date('2026-04-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + (i - 1));
      raw.push(obs(d.toISOString().slice(0, 10), String(i)));
    }
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'DGS2',
      observations: raw,
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    await fetchFredIndicator({
      indicatorCode: 'US_02Y_SMA',
      triggerType: 'manual',
      dateFrom: new Date('2026-04-01T00:00:00Z'),
      dateTo: new Date('2026-04-23T00:00:00Z'),
    });

    // 3 SMA rows: indices 20, 21, 22 → SMAs 11, 12, 13
    expect(mockedUpsert).toHaveBeenCalledTimes(3);
    expect(mockedUpsert.mock.calls[0][0].previousValue).toBeNull(); // no DB prior, no in-mem prior
    expect(mockedUpsert.mock.calls[1][0].previousValue).toBeCloseTo(11, 9);
    expect(mockedUpsert.mock.calls[2][0].previousValue).toBeCloseTo(12, 9);
  });

  it('uses in-memory prior SMA when buffer overlaps dateFrom', async () => {
    setupCommon('US_02Y_SMA', 'DGS2');
    mockedFindFirst.mockResolvedValueOnce(null);

    // 22 raw days starting 2026-04-01. dateFrom is set to 2026-04-22 (the last day),
    // so the SMA on day 21 (2026-04-21) falls inside the buffer and seeds lastSeen.
    const raw: ReturnType<typeof obs>[] = [];
    for (let i = 1; i <= 22; i++) {
      const d = new Date('2026-04-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + (i - 1));
      raw.push(obs(d.toISOString().slice(0, 10), String(i)));
    }
    mockedGetSeries.mockResolvedValueOnce({
      seriesId: 'DGS2',
      observations: raw,
      requestUrl: '',
      fetchedAt: new Date(),
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: null });

    await fetchFredIndicator({
      indicatorCode: 'US_02Y_SMA',
      triggerType: 'manual',
      dateFrom: new Date('2026-04-22T00:00:00Z'),
      dateTo: new Date('2026-04-22T00:00:00Z'),
    });

    // Only the 2026-04-22 SMA persists. Its previousValue should be yesterday's SMA = 11.
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    expect(mockedUpsert.mock.calls[0][0].value).toBeCloseTo(12, 9);
    expect(mockedUpsert.mock.calls[0][0].previousValue).toBeCloseTo(11, 9);
  });
});

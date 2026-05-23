import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/clients/fred/fred.client', () => ({
  fredClient: { getSeriesObservations: vi.fn() },
}));

import { fredClient } from '@core/clients/fred/fred.client';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';

const mockedGet = fredClient.getSeriesObservations as unknown as ReturnType<typeof vi.fn>;

describe('compassFredClient.fetchSeries', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it('returns observations sorted ascending with numeric values', async () => {
    mockedGet.mockResolvedValue({
      seriesId: 'BAMLH0A0HYM2',
      observations: [
        { date: '2026-05-14', value: '4.20', realtime_start: '', realtime_end: '' },
        { date: '2026-05-12', value: '4.10', realtime_start: '', realtime_end: '' },
        { date: '2026-05-13', value: '4.15', realtime_start: '', realtime_end: '' },
      ],
      requestUrl: '',
      fetchedAt: new Date(),
    });

    const rows = await compassFredClient.fetchSeries('BAMLH0A0HYM2', 30);
    expect(rows).toHaveLength(3);
    expect(rows[0].date.toISOString()).toBe('2026-05-12T00:00:00.000Z');
    expect(rows[0].value).toBe(4.1);
    expect(rows[1].value).toBe(4.15);
    expect(rows[2].value).toBe(4.2);
  });

  it("maps FRED '.' missing-value sentinel to null", async () => {
    mockedGet.mockResolvedValue({
      seriesId: 'T10Y2Y',
      observations: [
        { date: '2026-05-13', value: '.', realtime_start: '', realtime_end: '' },
        { date: '2026-05-14', value: '0.25', realtime_start: '', realtime_end: '' },
      ],
      requestUrl: '',
      fetchedAt: new Date(),
    });

    const rows = await compassFredClient.fetchSeries('T10Y2Y', 5);
    expect(rows[0].value).toBeNull();
    expect(rows[1].value).toBe(0.25);
  });

  it('passes observation_start / observation_end derived from daysBack', async () => {
    mockedGet.mockResolvedValue({
      seriesId: 'UNRATE',
      observations: [],
      requestUrl: '',
      fetchedAt: new Date(),
    });

    await compassFredClient.fetchSeries('UNRATE', 30);
    expect(mockedGet).toHaveBeenCalledTimes(1);
    const callArg = mockedGet.mock.calls[0][0];
    expect(callArg.seriesId).toBe('UNRATE');
    expect(typeof callArg.observationStart).toBe('string');
    expect(typeof callArg.observationEnd).toBe('string');
    expect(callArg.observationStart < callArg.observationEnd).toBe(true);
  });

  it('exposes the canonical series-ID mapping', () => {
    expect(compassFredClient.SERIES.HY_OAS).toBe('BAMLH0A0HYM2');
    expect(compassFredClient.SERIES.YIELD_2S10S).toBe('T10Y2Y');
    expect(compassFredClient.SERIES.CPI).toBe('CPIAUCSL');
    expect(compassFredClient.SERIES.GDP).toBe('GDP');
    expect(compassFredClient.SERIES.NFP).toBe('PAYEMS');
    expect(compassFredClient.SERIES.UNRATE).toBe('UNRATE');
  });
});

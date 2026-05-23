import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { fredClient } from '@core/clients/fred/fred.client';
import { AppError } from '@core/middleware/error-handler';

const FRED_BASE = 'https://api.stlouisfed.org';

describe('FredClient', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('fetches series observations successfully', async () => {
    const fakeResponse = {
      realtime_start: '2026-05-15',
      realtime_end: '2026-05-15',
      observation_start: '2025-01-01',
      observation_end: '2026-05-15',
      units: 'lin',
      output_type: 1,
      file_type: 'json',
      order_by: 'observation_date',
      sort_order: 'asc',
      count: 2,
      offset: 0,
      limit: 100000,
      observations: [
        {
          realtime_start: '2026-05-15',
          realtime_end: '2026-05-15',
          date: '2025-12-01',
          value: '5.22',
        },
        {
          realtime_start: '2026-05-15',
          realtime_end: '2026-05-15',
          date: '2026-01-01',
          value: '5.10',
        },
      ],
    };

    nock(FRED_BASE)
      .get('/fred/series/observations')
      .query(true)
      .reply(200, fakeResponse);

    const result = await fredClient.getSeriesObservations({
      seriesId: 'INDCPIALLMINMEI',
    });

    expect(result.seriesId).toBe('INDCPIALLMINMEI');
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0].value).toBe('5.22');
  });

  it('throws AppError(400) on FRED bad request', async () => {
    nock(FRED_BASE)
      .get('/fred/series/observations')
      .query(true)
      .reply(400, { error_message: 'series does not exist' });

    await expect(
      fredClient.getSeriesObservations({ seriesId: 'BOGUS_SERIES' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'FRED_BAD_REQUEST',
    });
  });

  it('throws AppError(429) on rate limit', async () => {
    nock(FRED_BASE)
      .get('/fred/series/observations')
      .query(true)
      .reply(429, { error_message: 'rate limit' });

    await expect(
      fredClient.getSeriesObservations({ seriesId: 'INDCPIALLMINMEI' }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'FRED_RATE_LIMITED',
    });
  });

  it('AppError instances have correct shape', async () => {
    nock(FRED_BASE)
      .get('/fred/series/observations')
      .query(true)
      .reply(400, { error_message: 'bad' });

    try {
      await fredClient.getSeriesObservations({ seriesId: 'X' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
    }
  });
});

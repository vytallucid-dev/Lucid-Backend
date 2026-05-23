import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';
import { AppError } from '@core/middleware/error-handler';
import { cftcClient } from '@core/clients/cftc/cftc.client';

const CFTC_HOST = 'https://publicreporting.cftc.gov';
const PATH = '/resource/6dca-aqww.json';

const SAMPLE_ROWS = [
  {
    market_and_exchange_names: 'USD INDEX - ICE FUTURES U.S.',
    report_date_as_yyyy_mm_dd: '2026-05-13T00:00:00.000',
    cftc_contract_market_code: '098662',
    noncomm_positions_long_all: '40000',
    noncomm_positions_short_all: '30000',
    change_in_noncomm_long_all: '1000',
    change_in_noncomm_short_all: '-500',
  },
];

describe('CftcClient', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('fetches recent legacy data and returns rows', async () => {
    nock(CFTC_HOST)
      .get(PATH)
      .query(true)
      .reply(200, SAMPLE_ROWS);

    const result = await cftcClient.fetchRecentLegacyData({ daysBack: 60 });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].cftc_contract_market_code).toBe('098662');
    expect(result.totalRowsReturned).toBe(1);
    expect(result.requestUrl).toBe(`${CFTC_HOST}${PATH}`);
  });

  it('URL-encodes the $where clause for IN list of contract codes', async () => {
    let capturedQuery: Record<string, string | string[]> | null = null;
    nock(CFTC_HOST)
      .get(PATH)
      .query((q) => {
        capturedQuery = q;
        return true;
      })
      .reply(200, []);

    await cftcClient.fetchRecentLegacyData({
      daysBack: 30,
      contractCodes: ['098662', '099741'],
    });

    expect(capturedQuery).not.toBeNull();
    const where = (capturedQuery as unknown as Record<string, string>).$where;
    expect(where).toContain("cftc_contract_market_code in('098662','099741')");
    expect(where).toContain('report_date_as_yyyy_mm_dd');
  });

  it('throws CFTC_RATE_LIMITED on 429', async () => {
    nock(CFTC_HOST)
      .get(PATH)
      .query(true)
      .reply(429, { error: 'rate limited' });

    try {
      await cftcClient.fetchRecentLegacyData();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(429);
      expect(appErr.code).toBe('CFTC_RATE_LIMITED');
    }
  });

  it('throws CFTC_UPSTREAM_ERROR on 500 after retries', async () => {
    nock(CFTC_HOST)
      .get(PATH)
      .query(true)
      .times(4)
      .reply(500, 'server error');

    try {
      await cftcClient.fetchRecentLegacyData();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(502);
      expect(appErr.code).toBe('CFTC_UPSTREAM_ERROR');
    }
  }, 30000);

  it('throws CFTC_PARSE_ERROR when response body is not an array', async () => {
    nock(CFTC_HOST)
      .get(PATH)
      .query(true)
      .reply(200, { error: 'unexpected shape' });

    try {
      await cftcClient.fetchRecentLegacyData();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('CFTC_PARSE_ERROR');
    }
  });

  describe('app token header', () => {
    const originalToken = process.env.CFTC_APP_TOKEN;

    afterEach(() => {
      if (originalToken === undefined) {
        delete process.env.CFTC_APP_TOKEN;
      } else {
        process.env.CFTC_APP_TOKEN = originalToken;
      }
      vi.resetModules();
    });

    it('adds X-App-Token header when CFTC_APP_TOKEN env var is set', async () => {
      process.env.CFTC_APP_TOKEN = 'test-token-abc';
      vi.resetModules();
      const { cftcClient: freshClient } = await import('@core/clients/cftc/cftc.client');

      let capturedHeader: string | undefined;
      nock(CFTC_HOST)
        .get(PATH)
        .query(true)
        .reply(function () {
          capturedHeader = this.req.headers['x-app-token'] as string | undefined;
          return [200, []];
        });

      await freshClient.fetchRecentLegacyData();
      expect(capturedHeader).toBe('test-token-abc');
    });

    it('omits X-App-Token header when CFTC_APP_TOKEN env var is not set', async () => {
      delete process.env.CFTC_APP_TOKEN;
      vi.resetModules();
      const { cftcClient: freshClient } = await import('@core/clients/cftc/cftc.client');

      let capturedHeader: string | undefined;
      nock(CFTC_HOST)
        .get(PATH)
        .query(true)
        .reply(function () {
          capturedHeader = this.req.headers['x-app-token'] as string | undefined;
          return [200, []];
        });

      await freshClient.fetchRecentLegacyData();
      expect(capturedHeader).toBeUndefined();
    });
  });
});

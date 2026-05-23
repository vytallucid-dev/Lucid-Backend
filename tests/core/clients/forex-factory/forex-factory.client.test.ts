import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { forexFactoryClient } from '@core/clients/forex-factory/forex-factory.client';
import { AppError } from '@core/middleware/error-handler';

const PRIMARY_HOST = 'https://nfs.faireconomy.media';
const FALLBACK_HOST = 'https://cdn-nfs.faireconomy.media';
const PATH = '/ff_calendar_thisweek.json';

const SAMPLE_EVENTS = [
  {
    title: 'CPI y/y',
    country: 'USD',
    date: '2026-05-21T08:30:00-04:00',
    impact: 'High',
    forecast: '3.5%',
    previous: '3.2%',
    actual: '3.4%',
    url: 'https://example.com/event/1',
  },
];

describe('ForexFactoryClient', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('fetches the weekly calendar successfully', async () => {
    nock(PRIMARY_HOST)
      .get(PATH)
      .reply(200, JSON.stringify(SAMPLE_EVENTS), {
        'content-type': 'application/json',
      });

    const result = await forexFactoryClient.getCalendarWeek();

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('CPI y/y');
    expect(result.events[0].country).toBe('USD');
    expect(result.requestUrl).toBe(`${PRIMARY_HOST}${PATH}`);
    expect(result.responseSizeBytes).toBeGreaterThan(0);
  });

  it('throws FF_RATE_LIMITED when primary returns HTML and CDN also rate-limits', async () => {
    nock(PRIMARY_HOST)
      .get(PATH)
      .reply(200, '<html><body>Rate limit</body></html>', {
        'content-type': 'text/html; charset=utf-8',
      });
    nock(FALLBACK_HOST)
      .get(PATH)
      .reply(200, '<html><body>Rate limit</body></html>', {
        'content-type': 'text/html; charset=utf-8',
      });

    try {
      await forexFactoryClient.getCalendarWeek();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(429);
      expect(appErr.code).toBe('FF_RATE_LIMITED');
    }
  });

  it('falls back to CDN when primary returns HTML rate-limit response', async () => {
    nock(PRIMARY_HOST)
      .get(PATH)
      .reply(200, '<html>Rate limit</html>', {
        'content-type': 'text/html; charset=utf-8',
      });
    nock(FALLBACK_HOST)
      .get(PATH)
      .reply(200, JSON.stringify(SAMPLE_EVENTS), {
        'content-type': 'application/json',
      });

    const result = await forexFactoryClient.getCalendarWeek();
    expect(result.events).toHaveLength(1);
    expect(result.requestUrl).toBe(`${FALLBACK_HOST}${PATH}`);
  });

  it('throws FF_UPSTREAM_ERROR on 500 after retries', async () => {
    nock(PRIMARY_HOST)
      .get(PATH)
      .times(4)
      .reply(500, 'server error', { 'content-type': 'text/plain' });

    try {
      await forexFactoryClient.getCalendarWeek();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(502);
      expect(appErr.code).toBe('FF_UPSTREAM_ERROR');
    }
  }, 30000);

  it('throws FF_PARSE_ERROR on invalid JSON (with application/json content-type)', async () => {
    nock(PRIMARY_HOST)
      .get(PATH)
      .reply(200, '[invalid json', { 'content-type': 'application/json' });

    try {
      await forexFactoryClient.getCalendarWeek();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('FF_PARSE_ERROR');
    }
  });
});

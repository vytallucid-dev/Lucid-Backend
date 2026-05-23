import { vi, describe, it, expect, beforeEach } from 'vitest';

const { historicalMock } = vi.hoisted(() => ({ historicalMock: vi.fn() }));

vi.mock('yahoo-finance2', () => {
  return {
    default: class YahooFinance {
      historical = historicalMock;
    },
  };
});

import { yahooClient } from '@core/clients/yahoo/yahoo.client';
import { AppError } from '@core/middleware/error-handler';

describe('YahooClient.fetchDailyHistory', () => {
  beforeEach(() => {
    historicalMock.mockReset();
  });

  it('maps yahoo rows and sorts ascending by date', async () => {
    historicalMock.mockResolvedValue([
      {
        date: new Date('2026-05-15T00:00:00Z'),
        open: 16,
        high: 17,
        low: 15.5,
        close: 16.5,
        adjClose: 16.5,
        volume: 1000,
      },
      {
        date: new Date('2026-05-13T00:00:00Z'),
        open: 15,
        high: 16,
        low: 14.5,
        close: 15.8,
        adjClose: 15.8,
        volume: 900,
      },
      {
        date: new Date('2026-05-14T00:00:00Z'),
        open: 15.8,
        high: 16.5,
        low: 15.5,
        close: 16,
        adjClose: 16,
        volume: 1100,
      },
    ]);

    const rows = await yahooClient.fetchDailyHistory({
      symbol: '^VIX',
      daysBack: 10,
    });

    expect(rows).toHaveLength(3);
    expect(rows[0].date.toISOString()).toBe('2026-05-13T00:00:00.000Z');
    expect(rows[1].date.toISOString()).toBe('2026-05-14T00:00:00.000Z');
    expect(rows[2].date.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    expect(rows[0].close).toBe(15.8);
  });

  it('falls back to close when adjClose is undefined', async () => {
    historicalMock.mockResolvedValue([
      {
        date: new Date('2026-05-15T00:00:00Z'),
        open: 16,
        high: 17,
        low: 15.5,
        close: 16.5,
        volume: 1000,
      },
    ]);

    const rows = await yahooClient.fetchDailyHistory({
      symbol: '^VIX',
      daysBack: 5,
    });
    expect(rows[0].adjClose).toBe(16.5);
  });

  it('throws AppError YAHOO_FETCH_FAILED on library error', async () => {
    historicalMock.mockRejectedValue(new Error('Network down'));

    try {
      await yahooClient.fetchDailyHistory({ symbol: 'GC=F', daysBack: 10 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(502);
      expect(appErr.code).toBe('YAHOO_FETCH_FAILED');
      expect(appErr.message).toContain('GC=F');
    }
  });

  it('throws YAHOO_FETCH_FAILED when result is not an array', async () => {
    historicalMock.mockResolvedValue({ unexpected: 'shape' });

    try {
      await yahooClient.fetchDailyHistory({ symbol: '^VIX', daysBack: 5 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('YAHOO_FETCH_FAILED');
    }
  });
});

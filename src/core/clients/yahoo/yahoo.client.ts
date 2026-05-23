import YahooFinance from 'yahoo-finance2';
import { AppError } from '@core/middleware/error-handler';
import { logger } from '@core/utils/logger';

export interface YahooHistoricalRow {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
}

export type YahooFetchOptions =
  | { symbol: string; daysBack: number }
  | { symbol: string; periodStart: Date; periodEnd: Date };

function isPeriodOptions(
  options: YahooFetchOptions,
): options is { symbol: string; periodStart: Date; periodEnd: Date } {
  return 'periodStart' in options;
}

class YahooClient {
  private readonly yf: InstanceType<typeof YahooFinance>;

  constructor() {
    this.yf = new YahooFinance();
  }

  /**
   * Fetch daily OHLCV for a Yahoo symbol. Accepts either:
   *   - `{ symbol, daysBack }` — window ending today, going back N calendar days
   *   - `{ symbol, periodStart, periodEnd }` — explicit date range (used by
   *     historical backfill so the window can be anchored at any past date)
   *
   * Returns rows sorted ascending by date.
   *
   * Throws AppError with code YAHOO_FETCH_FAILED on any error or empty result.
   */
  async fetchDailyHistory(
    options: YahooFetchOptions,
  ): Promise<YahooHistoricalRow[]> {
    let period1: Date;
    let period2: Date;
    if (isPeriodOptions(options)) {
      period1 = options.periodStart;
      period2 = options.periodEnd;
    } else {
      period2 = new Date();
      period1 = new Date();
      period1.setDate(period1.getDate() - options.daysBack);
    }

    try {
      const result = await this.yf.historical(options.symbol, {
        period1,
        period2,
        interval: '1d',
      });

      if (!Array.isArray(result)) {
        throw new AppError(
          502,
          `Yahoo returned non-array response for ${options.symbol}`,
          'YAHOO_FETCH_FAILED',
          { symbol: options.symbol },
        );
      }

      const mapped: YahooHistoricalRow[] = result.map((r) => ({
        date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        adjClose: r.adjClose ?? r.close,
        volume: r.volume,
      }));

      mapped.sort((a, b) => a.date.getTime() - b.date.getTime());

      logger.info(
        {
          symbol: options.symbol,
          period1: period1.toISOString().slice(0, 10),
          period2: period2.toISOString().slice(0, 10),
          rowCount: mapped.length,
        },
        'Yahoo: fetch successful',
      );

      return mapped;
    } catch (err) {
      if (err instanceof AppError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { symbol: options.symbol, message },
        'Yahoo: fetch failed',
      );
      throw new AppError(
        502,
        `Yahoo fetch failed for ${options.symbol}: ${message}`,
        'YAHOO_FETCH_FAILED',
        { symbol: options.symbol },
      );
    }
  }
}

export const yahooClient = new YahooClient();

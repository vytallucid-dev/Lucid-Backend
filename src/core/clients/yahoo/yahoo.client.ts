import YahooFinance from 'yahoo-finance2';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';

interface YahooChartQuote {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface YahooDailyRow {
  date: string; // YYYY-MM-DD
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
}

export interface FetchDailyHistoryParams {
  symbol: string;
  daysBack: number;
}

/**
 * Minimal Yahoo Finance client built on yahoo-finance2's `chart()` module (the
 * module the package's own docs steer users toward over the older `historical()`
 * — chart() is what backs this build). Generic over symbol so it can be reused
 * beyond Brent (BZ=F) later, but only daily OHLC history is implemented.
 *
 * No API key (Yahoo's chart endpoint is public) and no daily call cap/retry —
 * unlike EODHD/Crude Price, Yahoo has no published rate limit for this endpoint
 * and the orchestrator already isolates per-indicator fetch failures.
 */
class YahooClient {
  private readonly yf: InstanceType<typeof YahooFinance>;

  constructor() {
    this.yf = new YahooFinance();
  }

  /**
   * Fetch daily OHLC history for `symbol` over the last `daysBack` calendar days,
   * sorted ascending by date. Throws AppError(502, 'YAHOO_FETCH_FAILED') on any
   * upstream error, a non-array result, or an empty result.
   */
  async fetchDailyHistory(params: FetchDailyHistoryParams): Promise<YahooDailyRow[]> {
    const { symbol, daysBack } = params;
    const period1 = new Date();
    period1.setUTCDate(period1.getUTCDate() - daysBack);

    const startedAt = Date.now();
    try {
      logger.debug({ symbol, daysBack }, 'Yahoo: fetching daily history');

      const result = await this.yf.chart(symbol, {
        period1,
        interval: '1d',
        return: 'array',
      });

      const quotes: YahooChartQuote[] = Array.isArray(result?.quotes) ? result.quotes : [];
      if (quotes.length === 0) {
        throw new AppError(
          502,
          `Yahoo returned no daily history for '${symbol}'`,
          'YAHOO_FETCH_FAILED',
          { symbol, daysBack },
        );
      }

      const rows = quotes
        .filter((q: YahooChartQuote): q is YahooChartQuote & { close: number } => q.close !== null)
        .map(
          (q): YahooDailyRow => ({
            date: q.date.toISOString().slice(0, 10),
            open: q.open,
            high: q.high,
            low: q.low,
            close: q.close,
          }),
        )
        .sort((a: YahooDailyRow, b: YahooDailyRow) => a.date.localeCompare(b.date));

      if (rows.length === 0) {
        throw new AppError(
          502,
          `Yahoo returned only null-close rows for '${symbol}'`,
          'YAHOO_FETCH_FAILED',
          { symbol, daysBack },
        );
      }

      logger.info(
        { symbol, rowCount: rows.length, durationMs: Date.now() - startedAt },
        'Yahoo: daily history fetch successful',
      );

      return rows;
    } catch (error) {
      if (error instanceof AppError) throw error;

      const message = error instanceof Error ? error.message : String(error);
      logger.error({ symbol, daysBack, errorMessage: message }, 'Yahoo: fetch failed');

      throw new AppError(
        502,
        `Yahoo fetch failed for '${symbol}': ${message}`,
        'YAHOO_FETCH_FAILED',
        { symbol, daysBack },
      );
    }
  }
}

// Singleton — one client across the app
export const yahooClient = new YahooClient();

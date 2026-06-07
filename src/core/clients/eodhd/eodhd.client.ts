import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { env } from '@config/env';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { EodhdDataPoint, EodhdEodRow, EodhdCommodityResponse } from './types';

const EODHD_BASE_URL = 'https://eodhd.com/api';
const DEFAULT_TIMEOUT_MS = 30000;

// Refuse to make a call once this many have been made today (UTC). The free plan
// hard limit is 20 calls/day (resets midnight GMT); we cap at 15 to leave headroom.
const EODHD_DAILY_CALL_CAP = 15;

/**
 * Generic EODHD client. Shared infrastructure under core/clients so it can be
 * reused by any module (NIFTY price indicators today, EdgeFinder macro series
 * later). Methods take arbitrary symbols/codes and normalize both endpoint
 * shapes to the common `EodhdDataPoint` { date, value } type.
 *
 * Mirrors the FRED client: one axios instance with axios-retry, fail-fast on
 * 4xx, retry only on 5xx/network, AppError mapping, pino logging.
 */
class EodhdClient {
  private readonly http: AxiosInstance;

  // In-memory daily call counter. Resets when the UTC date rolls over.
  private callCount = 0;
  private callCountUtcDate = '';

  constructor() {
    this.http = axios.create({
      baseURL: EODHD_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      params: {
        api_token: env.EODHD_API_KEY,
        fmt: 'json',
      },
    });

    // Retry config:
    //   - Network errors and 5xx → exponential backoff (3 retries)
    //   - All 4xx (400 bad symbol, 401/403 auth, 404 not found, 429) fail fast —
    //     client errors are permanent and won't succeed on retry.
    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        const status = error.response?.status;
        if (status !== undefined && status >= 400 && status < 500) {
          return false;
        }
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          (status !== undefined && status >= 500)
        );
      },
      onRetry: (retryCount, error, requestConfig) => {
        logger.warn(
          {
            retryCount,
            url: requestConfig.url,
            errorMessage: error.message,
            status: error.response?.status,
          },
          'EODHD API retry',
        );
      },
    });
  }

  /**
   * In-memory rate-limit guard. Throws if making another call today would exceed
   * the daily cap. Counts one per logical request (axios-retry attempts on the
   * same request are not double-counted).
   */
  private guardDailyCap(symbol: string): void {
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (todayUtc !== this.callCountUtcDate) {
      this.callCountUtcDate = todayUtc;
      this.callCount = 0;
    }

    if (this.callCount >= EODHD_DAILY_CALL_CAP) {
      throw new AppError(
        429,
        `EODHD daily call cap reached (${EODHD_DAILY_CALL_CAP} for ${todayUtc}); ` +
          `refusing request for '${symbol}' to stay under the 20/day free-plan limit`,
        'EODHD_DAILY_CAP_EXCEEDED',
        { symbol, cap: EODHD_DAILY_CALL_CAP, utcDate: todayUtc },
      );
    }

    this.callCount += 1;
  }

  /**
   * Fetch a series from the standard EOD endpoint (/api/eod/{symbol}) and map
   * each row to { date, value: close }. Used for DXY.INDX, USDINR.FOREX, and any
   * other exchange/forex symbol. Output is sorted by date ASCENDING.
   */
  async fetchEodSeries(symbol: string, from?: string): Promise<EodhdDataPoint[]> {
    this.guardDailyCap(symbol);

    const params: Record<string, string> = {};
    if (from) params.from = from;

    const startedAt = Date.now();
    try {
      logger.debug({ symbol, params }, 'EODHD: fetching EOD series');

      const response = await this.http.get<EodhdEodRow[]>(`/eod/${symbol}`, { params });
      const rows = Array.isArray(response.data) ? response.data : [];

      const points = rows
        .map((row): EodhdDataPoint => ({ date: row.date, value: row.close }))
        .sort((a, b) => a.date.localeCompare(b.date));

      logger.info(
        { symbol, rowCount: points.length, durationMs: Date.now() - startedAt },
        'EODHD: EOD fetch successful',
      );

      return points;
    } catch (error) {
      throw this.toAppError(error, symbol, `/eod/${symbol}`);
    }
  }

  /**
   * Fetch a series from the commodities endpoint
   * (/api/commodities/historical/{code}) and map each data[] row to
   * { date, value }. Used for BRENT. Output is sorted by date ASCENDING.
   */
  async fetchCommoditySeries(code: string, from?: string): Promise<EodhdDataPoint[]> {
    this.guardDailyCap(code);

    const params: Record<string, string> = { interval: 'daily' };
    if (from) params.from = from;

    const startedAt = Date.now();
    try {
      logger.debug({ code, params }, 'EODHD: fetching commodity series');

      const response = await this.http.get<EodhdCommodityResponse>(
        `/commodities/historical/${code}`,
        { params },
      );
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];

      const points = rows
        .map((row): EodhdDataPoint => ({ date: row.date, value: row.value }))
        .sort((a, b) => a.date.localeCompare(b.date));

      logger.info(
        { code, rowCount: points.length, durationMs: Date.now() - startedAt },
        'EODHD: commodity fetch successful',
      );

      return points;
    } catch (error) {
      throw this.toAppError(error, code, `/commodities/historical/${code}`);
    }
  }

  /** Map an upstream/axios error to a typed AppError, mirroring the FRED client. */
  private toAppError(error: unknown, symbol: string, requestPath: string): AppError {
    // Rate-limit guard already throws AppError before the request — pass through.
    if (error instanceof AppError) return error;

    const axiosErr = error as AxiosError<{ message?: string } | string>;
    const statusCode = axiosErr.response?.status;
    const responseData = axiosErr.response?.data;
    const apiMessage =
      typeof responseData === 'string' ? responseData : responseData?.message;

    logger.error(
      { symbol, requestPath, statusCode, apiMessage, errorMessage: axiosErr.message },
      'EODHD: fetch failed',
    );

    // 400 / 404 = bad request (invalid symbol, unknown code) — non-retryable
    if (statusCode === 400 || statusCode === 404) {
      return new AppError(
        statusCode,
        `EODHD rejected request for '${symbol}': ${apiMessage ?? 'bad request'}`,
        'EODHD_BAD_REQUEST',
        { symbol, apiMessage },
      );
    }

    // 401 / 403 = auth failure (missing or invalid token)
    if (statusCode === 401 || statusCode === 403) {
      return new AppError(
        statusCode,
        `EODHD auth failed for '${symbol}' (check EODHD_API_KEY)`,
        'EODHD_AUTH_FAILED',
        { symbol },
      );
    }

    // 429 = upstream rate limit (daily quota exhausted on EODHD's side)
    if (statusCode === 429) {
      return new AppError(
        429,
        `EODHD rate limit exceeded for '${symbol}'`,
        'EODHD_RATE_LIMITED',
        { symbol },
      );
    }

    return new AppError(
      502,
      `EODHD API call failed for '${symbol}': ${axiosErr.message}`,
      'EODHD_UPSTREAM_ERROR',
      { symbol, statusCode, apiMessage },
    );
  }
}

// Singleton — one client across the app
export const eodhdClient = new EodhdClient();

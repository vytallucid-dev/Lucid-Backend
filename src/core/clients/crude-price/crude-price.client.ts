import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { env } from '@config/env';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';

const CRUDE_PRICE_BASE_URL = 'https://www.crudepriceapi.com';
const DEFAULT_TIMEOUT_MS = 30000;

// Refuse to make a call once this many have been made today (UTC). The free plan
// allows 100 requests/month; this in-memory guard caps daily calls well under that
// to protect against an accidental fetch loop. One Brent fetch per day needs 1.
const CRUDE_PRICE_DAILY_CALL_CAP = 5;

/**
 * Normalized result returned by the client. Only the two fields the NIFTY Brent
 * fetch needs are surfaced — the API's `formatted`, `currency`, `type` and
 * `next_two_months_predictions` (forecasts) are discarded and never returned.
 */
export interface CrudePriceLatest {
  price: number; // parsed from data.price (the API returns it as a string)
  observedAt: string; // data.created_at — ISO timestamp the price was recorded
}

/**
 * Raw envelope from GET /api/prices/latest. Only the fields the client reads are
 * typed; `next_two_months_predictions` is intentionally omitted so it can never be
 * accidentally consumed or stored.
 */
interface CrudePriceLatestResponse {
  status: string;
  data?: {
    price?: string;
    created_at?: string;
  };
}

/**
 * Crude Price API client. Shared infrastructure under core/clients so it can be
 * reused by any module (NIFTY Brent today, EdgeFinder later). The /latest endpoint
 * is Brent-specific (code BRENT_CRUDE_USD), so the method is named accordingly.
 *
 * Mirrors the EODHD client: one axios instance with axios-retry, fail-fast on 4xx,
 * retry only on 5xx/network, AppError mapping, pino logging, and an in-memory
 * daily call cap.
 */
class CrudePriceClient {
  private readonly http: AxiosInstance;

  // In-memory daily call counter. Resets when the UTC date rolls over.
  private callCount = 0;
  private callCountUtcDate = '';

  constructor() {
    this.http = axios.create({
      baseURL: CRUDE_PRICE_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${env.CRUDE_PRICE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    // Retry config:
    //   - Network errors and 5xx → exponential backoff (3 retries)
    //   - All 4xx (400 bad request, 401/403 auth, 404 not found, 429) fail fast —
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
          'Crude Price API retry',
        );
      },
    });
  }

  /**
   * In-memory rate-limit guard. Throws if making another call today would exceed
   * the daily cap. Counts one per logical request (axios-retry attempts on the
   * same request are not double-counted).
   */
  private guardDailyCap(): void {
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (todayUtc !== this.callCountUtcDate) {
      this.callCountUtcDate = todayUtc;
      this.callCount = 0;
    }

    if (this.callCount >= CRUDE_PRICE_DAILY_CALL_CAP) {
      throw new AppError(
        429,
        `Crude Price API daily call cap reached (${CRUDE_PRICE_DAILY_CALL_CAP} for ${todayUtc}); ` +
          `refusing request to stay under the 100/month free-plan limit`,
        'CRUDE_PRICE_DAILY_CAP_EXCEEDED',
        { cap: CRUDE_PRICE_DAILY_CALL_CAP, utcDate: todayUtc },
      );
    }

    this.callCount += 1;
  }

  /**
   * Fetch the latest Brent spot price from GET /api/prices/latest and return the
   * parsed price plus its timestamp. Extracts ONLY data.price and data.created_at;
   * everything else in the envelope — including next_two_months_predictions
   * (forecasts) — is discarded. Throws AppError 502 on a malformed/unsuccessful
   * envelope or an unparseable price.
   */
  async fetchLatestBrent(): Promise<CrudePriceLatest> {
    this.guardDailyCap();

    const startedAt = Date.now();
    try {
      logger.debug('Crude Price: fetching latest Brent spot price');

      const response = await this.http.get<CrudePriceLatestResponse>('/api/prices/latest');
      const body = response.data;

      if (body?.status !== 'success' || !body.data || body.data.price === undefined) {
        throw new AppError(
          502,
          `Crude Price API returned an unexpected payload (status=${body?.status ?? 'missing'})`,
          'CRUDE_PRICE_BAD_PAYLOAD',
          { status: body?.status },
        );
      }

      const price = Number(body.data.price);
      if (!Number.isFinite(price)) {
        throw new AppError(
          502,
          `Crude Price API returned an unparseable price: '${body.data.price}'`,
          'CRUDE_PRICE_BAD_VALUE',
          { rawPrice: body.data.price },
        );
      }

      const observedAt = body.data.created_at ?? new Date().toISOString();

      logger.info(
        { price, observedAt, durationMs: Date.now() - startedAt },
        'Crude Price: latest Brent fetch successful',
      );

      return { price, observedAt };
    } catch (error) {
      throw this.toAppError(error, '/api/prices/latest');
    }
  }

  /** Map an upstream/axios error to a typed AppError, mirroring the EODHD client. */
  private toAppError(error: unknown, requestPath: string): AppError {
    // Rate-limit guard and payload validation already throw AppError — pass through.
    if (error instanceof AppError) return error;

    const axiosErr = error as AxiosError<{ message?: string } | string>;
    const statusCode = axiosErr.response?.status;
    const responseData = axiosErr.response?.data;
    const apiMessage =
      typeof responseData === 'string' ? responseData : responseData?.message;

    logger.error(
      { requestPath, statusCode, apiMessage, errorMessage: axiosErr.message },
      'Crude Price: fetch failed',
    );

    // 400 / 404 = bad request — non-retryable
    if (statusCode === 400 || statusCode === 404) {
      return new AppError(
        statusCode,
        `Crude Price API rejected request: ${apiMessage ?? 'bad request'}`,
        'CRUDE_PRICE_BAD_REQUEST',
        { apiMessage },
      );
    }

    // 401 / 403 = auth failure (missing or invalid key)
    if (statusCode === 401 || statusCode === 403) {
      return new AppError(
        statusCode,
        `Crude Price API auth failed (check CRUDE_PRICE_API_KEY)`,
        'CRUDE_PRICE_AUTH_FAILED',
      );
    }

    // 429 = upstream rate limit (monthly quota exhausted on the provider's side)
    if (statusCode === 429) {
      return new AppError(
        429,
        `Crude Price API rate limit exceeded`,
        'CRUDE_PRICE_RATE_LIMITED',
      );
    }

    return new AppError(
      502,
      `Crude Price API call failed: ${axiosErr.message}`,
      'CRUDE_PRICE_UPSTREAM_ERROR',
      { statusCode, apiMessage },
    );
  }
}

// Singleton — one client across the app
export const crudePriceClient = new CrudePriceClient();

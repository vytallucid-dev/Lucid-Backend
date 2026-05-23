import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { env } from '@config/env';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { FredFetchOptions, FredFetchResult, FredObservationsResponse } from './types';

const FRED_BASE_URL = 'https://api.stlouisfed.org/fred';
const DEFAULT_TIMEOUT_MS = 30000;

class FredClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: FRED_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      params: {
        api_key: env.FRED_API_KEY,
        file_type: 'json',
      },
    });

    // Retry config:
    //   - Network errors and 5xx → standard exponential backoff (3 retries)
    //   - 403 specifically → fixed schedule (5s, 15s, 45s, 90s) up to 4
    //     retries. FRED's public CDN returns 403 when bursty traffic trips
    //     its throttle, so we back off long enough for the window to reset.
    //   - All other 4xx (400 bad request, 401 auth, 404 not found, 429)
    //     fail fast — they won't succeed on retry.
    const FORBIDDEN_BACKOFF_MS = [5_000, 15_000, 45_000, 90_000];
    axiosRetry(this.http, {
      retries: 4,
      retryDelay: (retryCount: number, error: AxiosError): number => {
        const status = error.response?.status;
        if (status === 403) {
          const idx = Math.min(retryCount - 1, FORBIDDEN_BACKOFF_MS.length - 1);
          return FORBIDDEN_BACKOFF_MS[idx];
        }
        return axiosRetry.exponentialDelay(retryCount);
      },
      retryCondition: (error: AxiosError) => {
        const status = error.response?.status;
        // 403 specifically — CDN throttle, retry with backoff
        if (status === 403) {
          return true;
        }
        // All other 4xx — fail fast
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
          'FRED API retry',
        );
      },
    });
  }

  /**
   * Fetches observations for a FRED series.
   * Returns raw FRED response observations + metadata for traceability.
   */
  async getSeriesObservations(options: FredFetchOptions): Promise<FredFetchResult> {
    const { seriesId, observationStart, observationEnd, limit } = options;

    const params: Record<string, string | number> = {
      series_id: seriesId,
    };
    if (observationStart) params.observation_start = observationStart;
    if (observationEnd) params.observation_end = observationEnd;
    if (limit !== undefined) params.limit = limit;

    const fetchedAt = new Date();
    const requestUrl = `${FRED_BASE_URL}/series/observations`;

    try {
      logger.debug({ seriesId, params }, 'FRED: fetching series observations');

      const response = await this.http.get<FredObservationsResponse>('/series/observations', {
        params,
      });

      logger.info(
        {
          seriesId,
          count: response.data.count,
          observationsReturned: response.data.observations.length,
        },
        'FRED: fetch successful',
      );

      return {
        seriesId,
        observations: response.data.observations,
        requestUrl,
        fetchedAt,
      };
    } catch (error) {
      const axiosErr = error as AxiosError<{ error_message?: string }>;
      const statusCode = axiosErr.response?.status;
      const fredMessage = axiosErr.response?.data?.error_message;

      logger.error(
        {
          seriesId,
          statusCode,
          fredMessage,
          errorMessage: axiosErr.message,
        },
        'FRED: fetch failed',
      );

      // 400 = bad request (invalid series_id, malformed params) — non-retryable
      if (statusCode === 400) {
        throw new AppError(
          400,
          `FRED rejected request for series '${seriesId}': ${fredMessage ?? 'bad request'}`,
          'FRED_BAD_REQUEST',
          { seriesId, fredMessage },
        );
      }

      // 429 = rate limited
      if (statusCode === 429) {
        throw new AppError(
          429,
          `FRED rate limit exceeded for series '${seriesId}'`,
          'FRED_RATE_LIMITED',
          { seriesId },
        );
      }

      throw new AppError(
        502,
        `FRED API call failed for series '${seriesId}': ${axiosErr.message}`,
        'FRED_UPSTREAM_ERROR',
        { seriesId, statusCode, fredMessage },
      );
    }
  }
}

// Singleton — one client across the app
export const fredClient = new FredClient();

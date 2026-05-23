import axios, { AxiosInstance, AxiosError, AxiosResponse } from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import {
  ForexFactoryCalendarResponse,
  ForexFactoryFetchResult,
} from './types';

const PRIMARY_BASE = 'https://nfs.faireconomy.media';
const ENDPOINT = '/ff_calendar_thisweek.json';
const DEFAULT_TIMEOUT_MS = 30000;

function isJsonResponse(contentType: string | undefined, body: string): boolean {
  if (!contentType || !contentType.includes('application/json')) return false;
  const trimmed = body.trim();
  return trimmed.startsWith('[') || trimmed.startsWith('{');
}

function buildHttpClient(baseURL: string): AxiosInstance {
  const http = axios.create({
    baseURL,
    timeout: DEFAULT_TIMEOUT_MS,
    // Use text transform so we can detect HTML rate-limit pages before parsing
    transformResponse: [(data: unknown): unknown => data],
    responseType: 'text',
  });

  axiosRetry(http, {
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
          baseURL: requestConfig.baseURL,
          errorMessage: error.message,
          status: error.response?.status,
        },
        'ForexFactory API retry',
      );
    },
  });

  return http;
}

class ForexFactoryClient {
  private readonly primary: AxiosInstance;

  constructor() {
    this.primary = buildHttpClient(PRIMARY_BASE);
  }

  /**
   * Fetches the current-week Forex Factory calendar JSON from the primary host.
   * If the host rate-limits the request (non-JSON / 429 response) the error is
   * propagated — the broken CDN fallback has been removed.
   */
  async getCalendarWeek(): Promise<ForexFactoryFetchResult> {
    const fetchedAt = new Date();
    return await this.fetchFrom(this.primary, PRIMARY_BASE, fetchedAt);
  }

  private async fetchFrom(
    http: AxiosInstance,
    baseURL: string,
    fetchedAt: Date,
  ): Promise<ForexFactoryFetchResult> {
    const requestUrl = `${baseURL}${ENDPOINT}`;

    let response: AxiosResponse<string>;
    try {
      logger.debug({ requestUrl }, 'ForexFactory: fetching calendar');
      response = await http.get<string>(ENDPOINT);
    } catch (error) {
      const axiosErr = error as AxiosError<unknown>;
      const statusCode = axiosErr.response?.status;

      logger.error(
        {
          requestUrl,
          statusCode,
          errorMessage: axiosErr.message,
        },
        'ForexFactory: fetch failed',
      );

      if (statusCode === 429) {
        throw new AppError(
          429,
          'ForexFactory rate limit exceeded',
          'FF_RATE_LIMITED',
          { requestUrl, statusCode },
        );
      }

      throw new AppError(
        502,
        `ForexFactory upstream call failed: ${axiosErr.message}`,
        'FF_UPSTREAM_ERROR',
        { requestUrl, statusCode },
      );
    }

    const contentType =
      typeof response.headers['content-type'] === 'string'
        ? response.headers['content-type']
        : undefined;
    const body = typeof response.data === 'string' ? response.data : '';

    if (!isJsonResponse(contentType, body)) {
      logger.warn(
        {
          requestUrl,
          contentType,
          bodyPreview: body.slice(0, 200),
        },
        'ForexFactory: non-JSON response (likely rate-limited)',
      );
      throw new AppError(
        429,
        'ForexFactory returned non-JSON response (rate-limited or error page)',
        'FF_RATE_LIMITED',
        { requestUrl, contentType },
      );
    }

    let events: ForexFactoryCalendarResponse;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        throw new Error('Response body is not a JSON array');
      }
      events = parsed as ForexFactoryCalendarResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ requestUrl, message }, 'ForexFactory: parse failed');
      throw new AppError(
        502,
        `ForexFactory response parse failed: ${message}`,
        'FF_PARSE_ERROR',
        { requestUrl },
      );
    }

    logger.info(
      { requestUrl, eventCount: events.length, responseSizeBytes: body.length },
      'ForexFactory: fetch successful',
    );

    return {
      events,
      fetchedAt,
      requestUrl,
      responseSizeBytes: body.length,
    };
  }
}

export const forexFactoryClient = new ForexFactoryClient();

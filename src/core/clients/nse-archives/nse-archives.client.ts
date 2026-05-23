/**
 * NSE Archives HTTP client.
 *
 * The archives subdomain (nsearchives.nseindia.com) serves static report files
 * publicly without requiring a session warmup. Used for participant-wise OI
 * CSV files and similar bulk downloads.
 *
 * Differs from NseClient (main nseindia.com API):
 *   - No session/cookie warmup needed
 *   - Returns raw text (CSV), not JSON
 *   - Same User-Agent + retry pattern as FRED client
 *   - 404 is a legitimate outcome (CSV not published yet / holiday)
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';

const NSE_ARCHIVES_BASE_URL = 'https://nsearchives.nseindia.com';
const DEFAULT_TIMEOUT_MS = 30000;

export interface NseArchivesFetchResult {
  body: string;
  url: string;
  fetchedAt: Date;
  status: number;
}

class NseArchivesClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: NSE_ARCHIVES_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/csv,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: (status) => status < 500 || status === 502 || status === 503,
    });

    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        const status = error.response?.status;
        if (status !== undefined && status >= 400 && status < 500) {
          return false; // never retry 4xx
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
          'NSE Archives retry',
        );
      },
    });
  }

  /**
   * Fetches a static file from the NSE archives subdomain.
   * Returns the raw text body + status code.
   * 404 is returned to the caller (not thrown) — let business logic decide.
   * 5xx and network errors throw AppError after retries exhausted.
   */
  async getFile(path: string): Promise<NseArchivesFetchResult> {
    const fetchedAt = new Date();
    const url = `${NSE_ARCHIVES_BASE_URL}${path}`;

    try {
      logger.debug({ path }, 'NSE Archives: fetching file');
      const response = await this.http.get<string>(path);

      if (response.status === 404) {
        logger.info({ path }, 'NSE Archives: file not found (404)');
        return { body: '', url, fetchedAt, status: 404 };
      }

      if (response.status >= 400) {
        throw new AppError(
          502,
          `NSE Archives returned status ${response.status} for ${path}`,
          'NSE_ARCHIVES_UPSTREAM_ERROR',
          { path, status: response.status },
        );
      }

      logger.info({ path, bytes: response.data.length }, 'NSE Archives: fetch successful');

      return {
        body: response.data,
        url,
        fetchedAt,
        status: response.status,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;

      const axiosErr = error as AxiosError;
      const status = axiosErr.response?.status;

      logger.error(
        { path, status, errorMessage: axiosErr.message },
        'NSE Archives: fetch failed',
      );

      throw new AppError(
        502,
        `NSE Archives fetch failed for ${path}: ${axiosErr.message}`,
        'NSE_ARCHIVES_FETCH_FAILED',
        { path, status },
      );
    }
  }
}

export const nseArchivesClient = new NseArchivesClient();

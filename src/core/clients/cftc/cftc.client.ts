import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { CftcFetchOptions, CftcFetchResult, CftcLegacyRow } from './types';

const CFTC_BASE_URL = 'https://publicreporting.cftc.gov';
const ENDPOINT = '/resource/6dca-aqww.json';
const DEFAULT_TIMEOUT_MS = 30000;

const DEFAULT_CONTRACT_CODES: readonly string[] = [
  '098662', // USD INDEX
  '099741', // EUR
  '096742', // GBP
  '097741', // JPY
  '088691', // GOLD
];

function buildHttpClient(): AxiosInstance {
  const headers: Record<string, string> = {};
  const appToken = process.env.CFTC_APP_TOKEN;
  if (appToken) {
    headers['X-App-Token'] = appToken;
  }

  const http = axios.create({
    baseURL: CFTC_BASE_URL,
    timeout: DEFAULT_TIMEOUT_MS,
    headers,
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
          errorMessage: error.message,
          status: error.response?.status,
        },
        'CFTC API retry',
      );
    },
  });

  return http;
}

function formatDateYyyyMmDd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

class CftcClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = buildHttpClient();
  }

  /**
   * Fetches recent rows from the Legacy Futures-only COT report,
   * filtered to the specified contract codes and date window.
   */
  async fetchRecentLegacyData(
    options?: CftcFetchOptions,
  ): Promise<CftcFetchResult> {
    const daysBack = options?.daysBack ?? 60;
    const contractCodes =
      options?.contractCodes && options.contractCodes.length > 0
        ? options.contractCodes
        : Array.from(DEFAULT_CONTRACT_CODES);

    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const cutoffStr = formatDateYyyyMmDd(cutoff);
    const inList = contractCodes.map((c) => `'${c}'`).join(',');
    const whereClause = `cftc_contract_market_code in(${inList}) AND report_date_as_yyyy_mm_dd > '${cutoffStr}'`;

    const params: Record<string, string | number> = {
      $where: whereClause,
      $order: 'report_date_as_yyyy_mm_dd DESC',
      $limit: 100,
    };

    const fetchedAt = new Date();
    const requestUrl = `${CFTC_BASE_URL}${ENDPOINT}`;

    try {
      logger.debug(
        { requestUrl, whereClause, contractCodes },
        'CFTC: fetching legacy futures-only rows',
      );

      const response = await this.http.get<unknown>(ENDPOINT, { params });

      if (!Array.isArray(response.data)) {
        throw new AppError(
          502,
          'CFTC returned non-array response body',
          'CFTC_PARSE_ERROR',
          { requestUrl },
        );
      }

      const rows = response.data as CftcLegacyRow[];

      logger.info(
        { requestUrl, totalRowsReturned: rows.length, daysBack },
        'CFTC: fetch successful',
      );

      return {
        rows,
        fetchedAt,
        requestUrl,
        totalRowsReturned: rows.length,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;

      if (error instanceof SyntaxError) {
        logger.error(
          { requestUrl, errorMessage: error.message },
          'CFTC: JSON parse failed',
        );
        throw new AppError(
          502,
          `CFTC response parse failed: ${error.message}`,
          'CFTC_PARSE_ERROR',
          { requestUrl },
        );
      }

      const axiosErr = error as AxiosError<unknown>;
      const statusCode = axiosErr.response?.status;

      logger.error(
        { requestUrl, statusCode, errorMessage: axiosErr.message },
        'CFTC: fetch failed',
      );

      if (statusCode === 429) {
        throw new AppError(
          429,
          'CFTC rate limit exceeded',
          'CFTC_RATE_LIMITED',
          { requestUrl, statusCode },
        );
      }

      throw new AppError(
        502,
        `CFTC upstream call failed: ${axiosErr.message}`,
        'CFTC_UPSTREAM_ERROR',
        { requestUrl, statusCode },
      );
    }
  }
}

export const cftcClient = new CftcClient();

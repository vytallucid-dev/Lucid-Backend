import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { splitCsvLine } from '@core/clients/bis/bis.client';

/**
 * Japanese Government Bond yields — Japan Ministry of Finance, historical daily CSV.
 *
 * WHY THIS SOURCE
 * ---------------
 * The Compass cross-country reading needs a daily Japanese long end, and Japan
 * is the one major market whose long end genuinely moves independently of the
 * US (20-day change correlation 0.377 against the US, versus 0.735 for Germany).
 * FRED has no daily JGB series. The MOF publishes the entire curve daily, free,
 * with no key, back to 1974.
 *
 * FORMAT
 * ------
 * One CSV, ~1.2MB, wide: a date column then one column per tenor
 * (1Y..40Y). Two traps:
 *   1. There is a banner line ABOVE the header, so the real header is line 2.
 *   2. Missing values are a literal "-", not blank. Treating "-" as a number
 *      yields NaN; treating it as zero would be a catastrophic silent error on
 *      a yield series.
 *
 * Dates are YYYY/MM/DD, not ISO.
 *
 * COVERAGE (verified against the Phase B manifest): 2Y from 1974-09-24,
 * 10Y from 1986-07-05, 20Y from 1986-12-01, 30Y from 1999-09-02.
 *
 * The file is refreshed with a lag of a few days, so the last observation is
 * routinely not today. Callers must flag staleness rather than assume currency.
 */

const MOF_JGB_URL =
  'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv';
const DEFAULT_TIMEOUT_MS = 120_000;

/** Tenor column labels as they appear in the MOF header. */
export type JgbTenor = '1Y' | '2Y' | '5Y' | '10Y' | '20Y' | '30Y' | '40Y';

export interface JgbObservation {
  date: Date;
  value: number;
}

export type JgbSeriesMap = Record<string, JgbObservation[]>;

/**
 * Parse the MOF wide CSV into one series per requested tenor.
 * Exported for unit testing against a committed fixture without HTTP.
 */
export function parseJgbCsv(csv: string, tenors: readonly JgbTenor[]): JgbSeriesMap {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 3) throw new Error('MOF: CSV too short to contain a header and data');

  // Line 0 is a banner ("Historical Data ..."); the real header is line 1. Be
  // defensive rather than assuming: find the first line whose second field is a
  // recognised tenor label.
  let headerIdx = lines.findIndex((l) => {
    const cells = splitCsvLine(l).map((c) => c.trim());
    return cells.length > 2 && /^\d+Y$/.test(cells[1]);
  });
  if (headerIdx === -1) headerIdx = 1;

  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim());
  const colFor = new Map<string, number>();
  for (const t of tenors) {
    const idx = header.indexOf(t);
    if (idx === -1) {
      throw new Error(`MOF: tenor column "${t}" not found (header: ${header.join(',')})`);
    }
    colFor.set(t, idx);
  }

  const out: JgbSeriesMap = {};
  for (const t of tenors) out[t] = [];

  for (const line of lines.slice(headerIdx + 1)) {
    const cells = splitCsvLine(line);
    const rawDate = (cells[0] ?? '').trim();
    // YYYY/MM/DD
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(rawDate);
    if (!m) continue;
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

    for (const t of tenors) {
      const raw = (cells[colFor.get(t)!] ?? '').trim();
      // "-" is the MOF's missing-value sentinel. Never coerce it.
      if (raw === '' || raw === '-') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      out[t].push({ date, value });
    }
  }

  for (const t of tenors) out[t].sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

class MofClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: DEFAULT_TIMEOUT_MS,
      responseType: 'text',
      headers: { 'User-Agent': 'Lucid/Compass' },
    });
    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        const status = error.response?.status;
        if (status !== undefined && status >= 400 && status < 500) return false;
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          (status !== undefined && status >= 500)
        );
      },
    });
  }

  async fetchJgbYields(
    tenors: readonly JgbTenor[] = ['2Y', '10Y', '30Y'],
  ): Promise<JgbSeriesMap> {
    try {
      const res = await this.http.get<string>(MOF_JGB_URL);
      const series = parseJgbCsv(String(res.data), tenors);
      logger.info(
        {
          tenors: tenors.map((t) => ({
            tenor: t,
            n: series[t].length,
            last: series[t].at(-1)?.date.toISOString().slice(0, 10) ?? null,
          })),
        },
        'MOF: JGB yields fetched',
      );
      return series;
    } catch (error) {
      const axiosErr = error as AxiosError;
      logger.error(
        { statusCode: axiosErr.response?.status, errorMessage: (error as Error).message },
        'MOF: JGB fetch failed',
      );
      throw new AppError(
        502,
        `MOF JGB fetch failed: ${(error as Error).message}`,
        'MOF_UPSTREAM_ERROR',
        { statusCode: axiosErr.response?.status },
      );
    }
  }
}

export const mofClient = new MofClient();

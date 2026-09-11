import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { splitCsvLine } from '@core/clients/bis/bis.client';

/**
 * German federal-securities yields — Deutsche Bundesbank BBSIS REST download.
 *
 * WHY THIS SOURCE
 * ---------------
 * The Compass cross-country reading separates a GLOBAL long-end move from a
 * US-SPECIFIC one, which needs a daily German curve. FRED carries Germany at
 * MONTHLY frequency only (IRLTLT01DEM156N), which is useless for a 20-day
 * change. The Bundesbank publishes daily.
 *
 * This is also the binding constraint on the whole cross-country reading:
 * daily German data starts 1997-08-07 (30Y only from 2000-08-02), so nothing
 * before 1997 can be said about the global long end at daily frequency.
 *
 * FORMAT — two traps
 * ------------------
 *   1. The payload is UTF-8 WITH A BOM. Left in place, the BOM becomes part of
 *      the first header cell and every column lookup silently misses.
 *   2. There are EIGHT metadata rows BELOW the header row, not above it — the
 *      usual `skip N leading lines` idiom does not work. Rows 1..8 are dropped
 *      and the header (row 0) is kept.
 *
 * Missing observations appear as empty cells (holidays, weekends).
 *
 * Series keys are BBSIS identifiers where R02XX / R10XX / R30XX select the
 * residual maturity.
 */

const BBK_BASE = 'https://api.statistiken.bundesbank.de/rest/download';
const DEFAULT_TIMEOUT_MS = 120_000;

/** Residual-maturity yields of listed federal securities, daily. */
const BBK_SERIES = {
  DE_2Y: 'BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R02XX.R.A.A._Z._Z.A',
  DE_10Y: 'BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A',
  DE_30Y: 'BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R30XX.R.A.A._Z._Z.A',
} as const;

export type BundesbankSeriesKey = keyof typeof BBK_SERIES;

export interface BundesbankObservation {
  date: Date;
  value: number;
}

/** Number of metadata rows that sit BELOW the header in a BBSIS csv payload. */
const METADATA_ROWS_BELOW_HEADER = 8;

/**
 * Parse one BBSIS CSV payload into a daily series.
 * Exported for unit testing against a committed fixture without HTTP.
 */
export function parseBbsisCsv(csv: string): BundesbankObservation[] {
  // Strip the UTF-8 BOM if present. Without this the first header cell is
  // "﻿date" and any header-based lookup misses silently.
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;

  const lines = text.split(/\r?\n/);
  if (lines.length < 2) throw new Error('Bundesbank: CSV too short');

  // Header is row 0; rows 1..8 are metadata (unit, decimals, comment, ...).
  const body = lines.slice(1 + METADATA_ROWS_BELOW_HEADER);

  const out: BundesbankObservation[] = [];
  for (const line of body) {
    if (line.trim().length === 0) continue;
    const cells = splitCsvLine(line);
    const rawDate = (cells[0] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) continue;
    const raw = (cells[1] ?? '').trim();
    if (raw === '' || raw === '.') continue;
    // BBSIS uses '.' as decimal separator in the REST csv payload.
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out.push({ date: new Date(`${rawDate}T00:00:00.000Z`), value });
  }
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

class BundesbankClient {
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

  async fetchSeries(key: BundesbankSeriesKey): Promise<BundesbankObservation[]> {
    const seriesKey = BBK_SERIES[key];
    try {
      const res = await this.http.get<string>(`${BBK_BASE}/${seriesKey}`, {
        params: { format: 'csv', lang: 'en' },
      });
      const obs = parseBbsisCsv(String(res.data));
      logger.info(
        {
          key,
          n: obs.length,
          first: obs[0]?.date.toISOString().slice(0, 10) ?? null,
          last: obs.at(-1)?.date.toISOString().slice(0, 10) ?? null,
        },
        'Bundesbank: series fetched',
      );
      return obs;
    } catch (error) {
      const axiosErr = error as AxiosError;
      logger.error(
        { key, statusCode: axiosErr.response?.status, errorMessage: (error as Error).message },
        'Bundesbank: fetch failed',
      );
      throw new AppError(
        502,
        `Bundesbank fetch failed for ${key}: ${(error as Error).message}`,
        'BUNDESBANK_UPSTREAM_ERROR',
        { key, statusCode: axiosErr.response?.status },
      );
    }
  }
}

export const bundesbankClient = new BundesbankClient();

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { readSingleZipEntry } from '@core/utils/zip';

/**
 * BIS daily central-bank policy rates (dataset WS_CBPOL, bulk download).
 *
 * WHY THIS SOURCE
 * ---------------
 * Policy rates are the ANCHOR for the Compass Yields module: a 2-year yield is
 * uninterpretable without the policy rate it is priced against, and the
 * "2Y minus policy" gap is what says how much tightening or easing is priced.
 * FRED cannot supply this at daily frequency for Japan (monthly only), whereas
 * the BIS bulk file carries daily series for the US from 1954, Japan from 1946
 * and the euro area from 1999.
 *
 * FORMAT — the awkward part
 * -------------------------
 * `WS_CBPOL_csv_col.zip` is a single deflate-compressed CSV in COLUMN layout:
 * one ROW per country and one COLUMN per date, ~5.5MB inflated and about 100
 * rows wide by tens of thousands of columns.
 *
 * Two traps:
 *   1. The date columns are mixed granularity. Alongside `1945-01-01` there are
 *      aggregate columns like `1945-01` (monthly) and `1945` (annual). Keeping
 *      them would silently fold a monthly average into a daily series, so only
 *      headers of exactly 10 characters matching YYYY-MM-DD are read.
 *   2. Leading metadata columns vary. They are identified by name rather than
 *      by position.
 *
 * No API key. No rate limit documented. Refreshed roughly daily, with a lag of
 * a few days — callers must treat the last observation as possibly stale rather
 * than assume it is today.
 */

const BIS_BULK_URL = 'https://data.bis.org/static/bulk/WS_CBPOL_csv_col.zip';
const DEFAULT_TIMEOUT_MS = 120_000;

/** Metadata columns that precede the date columns. Matched by name, not index. */
const META_COLUMNS = new Set([
  'FREQ',
  'Frequency',
  'REF_AREA',
  'Reference area',
  'TIME_FORMAT',
  'Time Format',
  'COMPILATION',
  'DECIMALS',
  'Decimals',
  'SOURCE_REF',
  'SUPP_INFO_BREAKS',
  'TITLE',
  'Series',
  'UNIT_MEASURE',
  'Unit of measure',
  'OBS_STATUS',
]);

const DATE_HEADER = /^\d{4}-\d{2}-\d{2}$/;

export type BisArea = 'US' | 'JP' | 'XM';

export interface BisObservation {
  date: Date;
  value: number;
}

export interface BisSeries {
  area: BisArea;
  /** The BIS's own description of what the rate is, including regime changes. */
  title: string;
  observations: BisObservation[];
}

/**
 * Split one CSV line, honouring double-quoted fields (BIS titles contain
 * commas and semicolons). Doubled quotes inside a quoted field are literal.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse the inflated wide CSV into per-area daily series.
 * Exported so it can be unit-tested against a committed fixture without HTTP.
 */
export function parseCbpolCsv(csv: string, areas: readonly BisArea[]): BisSeries[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('BIS: CSV has no data rows');

  const header = splitCsvLine(lines[0]);

  // Only true daily date columns. Anything that is not exactly YYYY-MM-DD is an
  // aggregate (YYYY-MM, YYYY) and would corrupt a daily series.
  const dateCols: Array<{ index: number; date: Date }> = [];
  for (let i = 0; i < header.length; i += 1) {
    const h = header[i].trim();
    if (META_COLUMNS.has(h)) continue;
    if (!DATE_HEADER.test(h)) continue;
    dateCols.push({ index: i, date: new Date(`${h}T00:00:00.000Z`) });
  }
  if (dateCols.length === 0) throw new Error('BIS: no YYYY-MM-DD columns found in header');

  const freqIdx = header.findIndex((h) => h.trim() === 'FREQ');
  const areaIdx = header.findIndex((h) => h.trim() === 'REF_AREA');
  const titleIdx = header.findIndex((h) => h.trim() === 'COMPILATION');
  if (areaIdx === -1) throw new Error('BIS: REF_AREA column not found');

  const out: BisSeries[] = [];
  for (const area of areas) {
    // Prefer the explicitly daily row; fall back to any row for the area.
    let row = lines
      .slice(1)
      .map(splitCsvLine)
      .find(
        (c) =>
          (c[areaIdx] ?? '').trim().toUpperCase() === area &&
          (freqIdx === -1 || (c[freqIdx] ?? '').trim() === 'D'),
      );
    if (!row) {
      row = lines
        .slice(1)
        .map(splitCsvLine)
        .find((c) => (c[areaIdx] ?? '').trim().toUpperCase() === area);
    }
    if (!row) {
      throw new Error(`BIS: no row found for REF_AREA=${area}`);
    }

    const observations: BisObservation[] = [];
    for (const { index, date } of dateCols) {
      const raw = (row[index] ?? '').trim();
      if (raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      observations.push({ date, value });
    }
    observations.sort((a, b) => a.date.getTime() - b.date.getTime());

    out.push({
      area,
      title: titleIdx === -1 ? '' : (row[titleIdx] ?? '').trim(),
      observations,
    });
  }
  return out;
}

class BisClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: DEFAULT_TIMEOUT_MS,
      responseType: 'arraybuffer',
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

  /** Download and parse the daily policy-rate series for the given areas. */
  async fetchPolicyRates(
    areas: readonly BisArea[] = ['US', 'JP', 'XM'],
  ): Promise<BisSeries[]> {
    try {
      const res = await this.http.get<ArrayBuffer>(BIS_BULK_URL);
      const zipped = Buffer.from(res.data);
      const { name, content } = readSingleZipEntry(zipped, (n) =>
        n.toLowerCase().endsWith('.csv'),
      );
      const series = parseCbpolCsv(content.toString('utf8'), areas);

      logger.info(
        {
          entry: name,
          zippedBytes: zipped.length,
          inflatedBytes: content.length,
          series: series.map((s) => ({
            area: s.area,
            n: s.observations.length,
            last: s.observations.at(-1)?.date.toISOString().slice(0, 10) ?? null,
          })),
        },
        'BIS: policy rates fetched',
      );
      return series;
    } catch (error) {
      const axiosErr = error as AxiosError;
      const statusCode = axiosErr.response?.status;
      logger.error(
        { statusCode, errorMessage: (error as Error).message },
        'BIS: policy rate fetch failed',
      );
      throw new AppError(
        502,
        `BIS policy rate fetch failed: ${(error as Error).message}`,
        'BIS_UPSTREAM_ERROR',
        { statusCode },
      );
    }
  }
}

export const bisClient = new BisClient();

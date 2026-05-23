import { Indicator } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { nseClient } from '@core/clients/nse/nse.client';
import { NseAllIndicesResponse, NseIndexRow } from '@core/clients/nse/types';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';

const VIX_INDICATOR_CODE = 'IND_NIFTY_08_VIX';
const VIX_ROW_NAME = 'INDIA VIX';
const ALL_INDICES_PATH = '/api/allIndices';

export interface ScrapeNseVixParams {
  triggerType: 'cron' | 'manual' | 'backfill';
  triggeredBy?: string | null;
}

export interface ScrapeNseVixResult {
  indicatorCode: string;
  logId: string;
  status: 'success' | 'failed';
  action: 'inserted' | 'revised' | 'skipped' | null;
  observationDate: string | null;
  value: number | null;
  errors?: unknown[];
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const NSE_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/**
 * Parse NSE timestamp like "16-May-2026 15:30:00" → UTC Date at 00:00 of that day.
 * Falls back to today (UTC) if the format is unexpected — VIX must always land somewhere.
 */
function parseNseObservationDate(timestamp: string | undefined): Date {
  if (timestamp) {
    const datePart = timestamp.split(' ')[0];
    const segments = datePart.split('-');
    if (segments.length === 3) {
      const [day, monthStr, year] = segments;
      const month = NSE_MONTHS[monthStr];
      if (month !== undefined && /^\d+$/.test(day) && /^\d{4}$/.test(year)) {
        return new Date(Date.UTC(Number(year), month, Number(day)));
      }
    }
    logger.warn({ timestamp }, 'NSE: could not parse timestamp, falling back to today');
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function loadVixIndicator(): Promise<Indicator> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: VIX_INDICATOR_CODE },
  });

  if (!indicator) {
    throw new AppError(404, `Indicator not found: ${VIX_INDICATOR_CODE}`, 'INDICATOR_NOT_FOUND');
  }

  if (indicator.dataSource !== 'nse_scrape') {
    throw new AppError(
      400,
      `Indicator ${VIX_INDICATOR_CODE} is not an NSE-scraped indicator (data_source=${indicator.dataSource})`,
      'INVALID_DATA_SOURCE',
    );
  }

  return indicator;
}

function extractVixRow(rows: NseIndexRow[]): NseIndexRow {
  const vixRow = rows.find((r) => r.index?.toUpperCase() === VIX_ROW_NAME);
  if (!vixRow) {
    throw new AppError(
      502,
      `INDIA VIX row not found in NSE allIndices response (got ${rows.length} indices)`,
      'NSE_VIX_ROW_MISSING',
    );
  }
  if (typeof vixRow.last !== 'number' || !Number.isFinite(vixRow.last)) {
    throw new AppError(
      502,
      `INDIA VIX row has invalid 'last' value: ${vixRow.last}`,
      'NSE_VIX_INVALID_VALUE',
      { rawValue: vixRow.last },
    );
  }
  return vixRow;
}

/**
 * Scrape India VIX from NSE allIndices endpoint, persist as a vintage-aware
 * data point, and write a fetch log row. Idempotent — re-running on the same
 * trading day with the same value is a no-op.
 */
export async function scrapeNseVix(params: ScrapeNseVixParams): Promise<ScrapeNseVixResult> {
  const indicator = await loadVixIndicator();

  const log = await dataFetchLogRepository.start({
    jobName: 'scrape_nse_vix',
    triggerType: params.triggerType,
    triggeredBy: params.triggeredBy ?? null,
    metadata: {
      indicatorCode: indicator.code,
      endpoint: ALL_INDICES_PATH,
    },
  });

  try {
    const response = await nseClient.get<NseAllIndicesResponse>(ALL_INDICES_PATH);

    if (!response?.data || !Array.isArray(response.data)) {
      throw new AppError(
        502,
        'NSE allIndices response missing data array',
        'NSE_INVALID_RESPONSE',
      );
    }

    const vixRow = extractVixRow(response.data);
    const observationDate = parseNseObservationDate(response.timestamp);

    const upsertResult = await dataPointsRepository.upsert({
      indicatorId: indicator.id,
      observationDate,
      value: vixRow.last,
      source: 'nse_scrape',
      sourceMetadata: {
        endpoint: ALL_INDICES_PATH,
        nseTimestamp: response.timestamp ?? null,
        index: vixRow.index,
        previousClose: vixRow.previousClose ?? null,
        open: vixRow.open ?? null,
        high: vixRow.high ?? null,
        low: vixRow.low ?? null,
        percentChange: vixRow.percentChange ?? null,
      },
      fetchedVia: log.id,
    });

    const action = upsertResult.action;
    const rowsInserted = action === 'inserted' ? 1 : 0;
    const rowsUpdated = action === 'revised' ? 1 : 0;
    const rowsSkipped = action === 'skipped' ? 1 : 0;

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
    });

    logger.info(
      {
        indicatorCode: indicator.code,
        observationDate: toIsoDate(observationDate),
        value: vixRow.last,
        action,
      },
      'NSE VIX scrape complete',
    );

    return {
      indicatorCode: indicator.code,
      logId: log.id,
      status: 'success',
      action,
      observationDate: toIsoDate(observationDate),
      value: vixRow.last,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof AppError ? err.code : 'UNKNOWN',
    };
    logger.error({ ...errorPayload, indicatorCode: indicator.code }, 'NSE VIX scrape failed');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });

    return {
      indicatorCode: indicator.code,
      logId: log.id,
      status: 'failed',
      action: null,
      observationDate: null,
      value: null,
      errors: [errorPayload],
    };
  }
}

import { Indicator } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { nseArchivesClient } from '@core/clients/nse-archives/nse-archives.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { parseParticipantOiCsv } from './nse-participant-oi.parser';

const INDICATOR_CODE = 'IND_NIFTY_13_FII_LS_RATIO';
const REQUEST_DELAY_MS = 1500;
const MAX_BACKFILL_DAYS = 365;

export type ScrapeMode = 'today' | 'single_date' | 'backfill';
export type PerDateOutcome = 'inserted' | 'revised' | 'skipped' | 'no_data' | 'failed';

export interface ScrapeNseParticipantOiParams {
  triggerType: 'cron' | 'manual' | 'backfill';
  triggeredBy?: string | null;
  observationDate?: Date; // single specific date
  dateFrom?: Date; // backfill range start (inclusive)
  dateTo?: Date; // backfill range end (inclusive)
}

export interface PerDateResult {
  date: string; // YYYY-MM-DD
  outcome: PerDateOutcome;
  value?: number;
  error?: string;
}

export interface ScrapeNseParticipantOiResult {
  logId: string;
  status: 'success' | 'partial' | 'failed';
  mode: ScrapeMode;
  dateFrom: string | null;
  dateTo: string | null;
  summary: {
    totalDatesAttempted: number;
    inserted: number;
    revised: number;
    skipped: number;
    noData: number;
    failed: number;
  };
  details: PerDateResult[];
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toDdmmyyyy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getUTCFullYear());
  return `${dd}${mm}${yyyy}`;
}

function todayInIstAsUtcMidnight(): Date {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffsetMs);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function* dateRange(from: Date, to: Date): Generator<Date> {
  const cursor = new Date(from);
  while (cursor.getTime() <= to.getTime()) {
    yield new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function determineMode(observationDate?: Date, dateFrom?: Date, dateTo?: Date): ScrapeMode {
  if (dateFrom && dateTo) return 'backfill';
  if (observationDate) return 'single_date';
  return 'today';
}

async function loadIndicator(): Promise<Indicator> {
  const ind = await prisma.indicator.findUnique({ where: { code: INDICATOR_CODE } });
  if (!ind) {
    throw new AppError(404, `Indicator not found: ${INDICATOR_CODE}`, 'INDICATOR_NOT_FOUND');
  }
  if (ind.dataSource !== 'nse_scrape') {
    throw new AppError(
      400,
      `${INDICATOR_CODE} expected data_source=nse_scrape, got ${ind.dataSource}`,
      'INVALID_DATA_SOURCE',
    );
  }
  return ind;
}

/**
 * Fetch + parse + upsert one date. Used by both single-date and backfill flows.
 * Returns the per-date outcome.
 *
 * On HTTP 404 → outcome: 'no_data' (holiday/weekend/pre-publication).
 * On parse or DB error → outcome: 'failed' with error message captured.
 */
async function fetchAndStoreOne(
  ind: Indicator,
  requestedDate: Date,
  logId: string,
): Promise<PerDateResult> {
  const ddmmyyyy = toDdmmyyyy(requestedDate);
  const path = `/content/nsccl/fao_participant_oi_${ddmmyyyy}.csv`;

  try {
    const fetchResult = await nseArchivesClient.getFile(path);

    if (fetchResult.status === 404) {
      return { date: toIsoDate(requestedDate), outcome: 'no_data' };
    }

    const parsed = parseParticipantOiCsv(fetchResult.body);

    // The CSV's internal date is authoritative. If it differs from requested,
    // log a warning (NSE sometimes serves a previous file for a holiday URL).
    if (parsed.observationDate.getTime() !== requestedDate.getTime()) {
      logger.warn(
        {
          requestedDate: toIsoDate(requestedDate),
          csvDate: toIsoDate(parsed.observationDate),
        },
        'NSE OI: CSV date differs from requested date — using CSV date',
      );
    }

    const upsert = await dataPointsRepository.upsert({
      indicatorId: ind.id,
      observationDate: parsed.observationDate,
      value: parsed.longPct,
      source: 'nse_scrape',
      sourceMetadata: {
        url: fetchResult.url,
        futureIndexLong: parsed.futureIndexLong,
        futureIndexShort: parsed.futureIndexShort,
        totalFutures: parsed.futureIndexLong + parsed.futureIndexShort,
        formula: 'long / (long + short) * 100',
        rawHeaders: parsed.rawHeaders,
        rawFiiRow: parsed.rawFiiRow,
      },
      fetchedVia: logId,
    });

    return {
      date: toIsoDate(parsed.observationDate),
      outcome: upsert.action,
      value: parsed.longPct,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ date: toIsoDate(requestedDate), message }, 'NSE OI: per-date fetch failed');
    return {
      date: toIsoDate(requestedDate),
      outcome: 'failed',
      error: message,
    };
  }
}

/**
 * Top-level orchestrator. Handles today / single-date / backfill modes uniformly.
 * Writes one fetch_log row covering the entire run.
 */
export async function scrapeNseParticipantOi(
  params: ScrapeNseParticipantOiParams,
): Promise<ScrapeNseParticipantOiResult> {
  const ind = await loadIndicator();
  const mode = determineMode(params.observationDate, params.dateFrom, params.dateTo);

  // Resolve the date range
  let firstDate: Date;
  let lastDate: Date;
  if (mode === 'backfill') {
    firstDate = params.dateFrom as Date;
    lastDate = params.dateTo as Date;

    if (firstDate.getTime() > lastDate.getTime()) {
      throw new AppError(400, 'date_from must be <= date_to', 'INVALID_DATE_RANGE');
    }

    const rangeDays =
      Math.floor((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    if (rangeDays > MAX_BACKFILL_DAYS) {
      throw new AppError(
        400,
        `Backfill range ${rangeDays} days exceeds max ${MAX_BACKFILL_DAYS}`,
        'BACKFILL_RANGE_TOO_LARGE',
        { rangeDays, max: MAX_BACKFILL_DAYS },
      );
    }
  } else if (mode === 'single_date') {
    firstDate = params.observationDate as Date;
    lastDate = params.observationDate as Date;
  } else {
    firstDate = todayInIstAsUtcMidnight();
    lastDate = firstDate;
  }

  const log = await dataFetchLogRepository.start({
    jobName: 'scrape_nse_participant_oi',
    triggerType: params.triggerType,
    triggeredBy: params.triggeredBy ?? null,
    targetDateFrom: firstDate,
    targetDateTo: lastDate,
    metadata: {
      indicatorCode: INDICATOR_CODE,
      mode,
    },
  });

  const details: PerDateResult[] = [];

  try {
    let firstIter = true;
    for (const date of dateRange(firstDate, lastDate)) {
      // Rate limit between requests (skip the delay on the very first iteration)
      if (!firstIter) {
        await sleep(REQUEST_DELAY_MS);
      }
      firstIter = false;

      const result = await fetchAndStoreOne(ind, date, log.id);
      details.push(result);
    }

    const summary = {
      totalDatesAttempted: details.length,
      inserted: details.filter((d) => d.outcome === 'inserted').length,
      revised: details.filter((d) => d.outcome === 'revised').length,
      skipped: details.filter((d) => d.outcome === 'skipped').length,
      noData: details.filter((d) => d.outcome === 'no_data').length,
      failed: details.filter((d) => d.outcome === 'failed').length,
    };

    const status: 'success' | 'partial' | 'failed' =
      summary.failed === 0
        ? 'success'
        : summary.inserted + summary.revised + summary.skipped + summary.noData === 0
          ? 'failed'
          : 'partial';

    await dataFetchLogRepository.complete({
      logId: log.id,
      status,
      rowsInserted: summary.inserted,
      rowsUpdated: summary.revised,
      rowsSkipped: summary.skipped + summary.noData,
      errors:
        summary.failed > 0
          ? (details.filter((d) => d.outcome === 'failed') as unknown as object)
          : undefined,
    });

    logger.info({ mode, summary }, 'NSE Participant OI scrape complete');

    return {
      logId: log.id,
      status,
      mode,
      dateFrom: toIsoDate(firstDate),
      dateTo: toIsoDate(lastDate),
      summary,
      details,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof AppError ? err.code : 'UNKNOWN',
    };
    logger.error({ ...errorPayload }, 'NSE Participant OI scrape crashed');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });

    return {
      logId: log.id,
      status: 'failed',
      mode,
      dateFrom: toIsoDate(firstDate),
      dateTo: toIsoDate(lastDate),
      summary: {
        totalDatesAttempted: details.length,
        inserted: 0,
        revised: 0,
        skipped: 0,
        noData: 0,
        failed: details.length,
      },
      details,
    };
  }
}

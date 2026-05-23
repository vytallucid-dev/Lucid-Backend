import { Indicator } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { fredClient } from '@core/clients/fred/fred.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import type { FredObservation } from '@core/clients/fred/types';

const DEFAULT_BACKFILL_YEARS = 2;
const REVISION_BUFFER_DAYS = 30;
const US_02Y_SMA_CODE = 'US_02Y_SMA';
const US_02Y_SMA_WINDOW = 21;
const US_02Y_SMA_LOOKBACK_BUFFER_DAYS = 30;

export interface FetchFredIndicatorParams {
  indicatorCode: string;
  dateFrom?: Date;
  dateTo?: Date;
  triggerType: 'cron' | 'manual' | 'backfill';
  triggeredBy?: string | null;
}

export interface FetchFredIndicatorResult {
  indicatorCode: string;
  logId: string;
  status: 'success' | 'partial' | 'failed';
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  observationsReceived: number;
  dateFrom: string | null;
  dateTo: string | null;
  errors?: unknown[];
}

interface IngestionRunResult {
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  observationsReceived: number;
  errors: unknown[];
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseFredValue(raw: string): number | null {
  // FRED uses "." to indicate missing values
  if (raw === '.' || raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function sortObservationsAscending(observations: FredObservation[]): FredObservation[] {
  return [...observations].sort((a, b) => a.date.localeCompare(b.date));
}

async function loadFredIndicator(indicatorCode: string): Promise<Indicator> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: indicatorCode },
  });

  if (!indicator) {
    throw new AppError(404, `Indicator not found: ${indicatorCode}`, 'INDICATOR_NOT_FOUND');
  }

  if (indicator.dataSource !== 'fred') {
    throw new AppError(
      400,
      `Indicator ${indicatorCode} is not a FRED-sourced indicator (data_source=${indicator.dataSource})`,
      'INVALID_DATA_SOURCE',
    );
  }

  if (!indicator.sourceSeriesId) {
    throw new AppError(
      500,
      `Indicator ${indicatorCode} has no source_series_id configured`,
      'MISSING_SOURCE_SERIES_ID',
    );
  }

  return indicator;
}

async function resolveDateRange(
  indicatorId: string,
  explicitFrom?: Date,
  explicitTo?: Date,
): Promise<{ dateFrom: Date; dateTo: Date }> {
  const dateTo = explicitTo ?? new Date();

  if (explicitFrom) {
    return { dateFrom: explicitFrom, dateTo };
  }

  // Smart catch-up: pull from (latest - buffer) or default backfill window
  const latest = await dataPointsRepository.getLatestObservationDate(indicatorId);

  if (latest) {
    const dateFrom = new Date(latest);
    dateFrom.setDate(dateFrom.getDate() - REVISION_BUFFER_DAYS);
    return { dateFrom, dateTo };
  }

  // No existing data — default backfill
  const dateFrom = new Date();
  dateFrom.setFullYear(dateFrom.getFullYear() - DEFAULT_BACKFILL_YEARS);
  return { dateFrom, dateTo };
}

async function fetchPriorValue(
  indicatorId: string,
  beforeDate: Date,
): Promise<number | null> {
  const prior = await prisma.dataPoint.findFirst({
    where: {
      indicatorId,
      isCurrent: true,
      observationDate: { lt: beforeDate },
    },
    orderBy: { observationDate: 'desc' },
    select: { value: true },
  });
  return prior ? Number(prior.value) : null;
}

/**
 * Generic FRED ingestion path: persist each observation as-is, chaining
 * previous_value from the running last-seen value (DB prior on first obs).
 */
async function ingestGenericObservations(
  indicator: Indicator,
  observations: FredObservation[],
  logId: string,
): Promise<IngestionRunResult> {
  const sorted = sortObservationsAscending(observations);

  let rowsInserted = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;
  const errors: unknown[] = [];

  let lastSeenValue: number | null = null;
  if (sorted.length > 0) {
    const firstObsDate = new Date(`${sorted[0].date}T00:00:00.000Z`);
    lastSeenValue = await fetchPriorValue(indicator.id, firstObsDate);
  }

  for (const obs of sorted) {
    const numericValue = parseFredValue(obs.value);
    if (numericValue === null) {
      rowsSkipped += 1;
      continue;
    }

    try {
      const observationDate = new Date(`${obs.date}T00:00:00.000Z`);
      const result = await dataPointsRepository.upsert({
        indicatorId: indicator.id,
        observationDate,
        value: numericValue,
        forecastValue: null,
        previousValue: lastSeenValue,
        source: 'fred',
        sourceMetadata: {
          seriesId: indicator.sourceSeriesId,
          realtimeStart: obs.realtime_start,
          realtimeEnd: obs.realtime_end,
          rawValue: obs.value,
        },
        fetchedVia: logId,
      });

      if (result.action === 'inserted') rowsInserted += 1;
      else if (result.action === 'revised') rowsUpdated += 1;
      else rowsSkipped += 1;

      // Chain forward — the value is now the canonical "previous" for the next obs.
      lastSeenValue = numericValue;
    } catch (err) {
      const errorPayload = {
        observationDate: obs.date,
        rawValue: obs.value,
        message: err instanceof Error ? err.message : String(err),
      };
      logger.error({ ...errorPayload, indicatorCode: indicator.code }, 'Failed to upsert observation');
      errors.push(errorPayload);
    }
  }

  return {
    rowsInserted,
    rowsUpdated,
    rowsSkipped,
    observationsReceived: observations.length,
    errors,
  };
}

/**
 * Special-case path for US_02Y_SMA: fetch raw DGS2 yields with a lookback buffer,
 * compute the 21-day trailing SMA, and persist the SMA (NOT the raw yield) as
 * the indicator's value.
 */
async function fetchFredIndicatorWithSmaTransform(
  indicator: Indicator,
  dateFrom: Date,
  dateTo: Date,
  logId: string,
  windowDays: number,
): Promise<IngestionRunResult> {
  const extendedDateFrom = new Date(dateFrom);
  extendedDateFrom.setDate(extendedDateFrom.getDate() - US_02Y_SMA_LOOKBACK_BUFFER_DAYS);

  const fetchResult = await fredClient.getSeriesObservations({
    seriesId: indicator.sourceSeriesId as string,
    observationStart: toIsoDate(extendedDateFrom),
    observationEnd: toIsoDate(dateTo),
  });

  const observationsReceived = fetchResult.observations.length;

  // Filter to valid numeric observations, then sort ascending (defensive).
  const rawPoints: { date: string; value: number }[] = [];
  for (const obs of fetchResult.observations) {
    const v = parseFredValue(obs.value);
    if (v === null) continue;
    rawPoints.push({ date: obs.date, value: v });
  }
  rawPoints.sort((a, b) => a.date.localeCompare(b.date));

  const dateFromIso = toIsoDate(dateFrom);
  const rawDateRange: [string, string] | null =
    rawPoints.length > 0 ? [rawPoints[0].date, rawPoints[rawPoints.length - 1].date] : null;

  let rowsInserted = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;
  const errors: unknown[] = [];

  // Pre-fetch the most recent persisted SMA prior to dateFrom — used as the seed
  // for previous_value chaining when our in-memory lookback can't reach far enough back.
  let lastSeenValue: number | null = await fetchPriorValue(indicator.id, dateFrom);

  for (let i = 0; i < rawPoints.length; i++) {
    if (i < windowDays - 1) {
      // Not enough lookback yet — neither persist nor count as skipped (it's
      // expected behavior, this row only exists as lookback fodder).
      continue;
    }

    let sum = 0;
    for (let j = i - windowDays + 1; j <= i; j++) sum += rawPoints[j].value;
    const sma = sum / windowDays;

    const obsDateIso = rawPoints[i].date;
    if (obsDateIso < dateFromIso) {
      // SMA falls inside the lookback buffer — use it to seed chaining,
      // but don't persist.
      lastSeenValue = sma;
      continue;
    }

    try {
      const observationDate = new Date(`${obsDateIso}T00:00:00.000Z`);
      const result = await dataPointsRepository.upsert({
        indicatorId: indicator.id,
        observationDate,
        value: sma,
        forecastValue: null,
        previousValue: lastSeenValue,
        source: 'fred',
        sourceMetadata: {
          seriesId: indicator.sourceSeriesId,
          windowDays,
          rawDataPointsUsed: windowDays,
          rawDateRange,
        },
        fetchedVia: logId,
      });

      if (result.action === 'inserted') rowsInserted += 1;
      else if (result.action === 'revised') rowsUpdated += 1;
      else rowsSkipped += 1;

      lastSeenValue = sma;
    } catch (err) {
      const errorPayload = {
        observationDate: obsDateIso,
        smaValue: sma,
        message: err instanceof Error ? err.message : String(err),
      };
      logger.error(
        { ...errorPayload, indicatorCode: indicator.code },
        'Failed to upsert SMA observation',
      );
      errors.push(errorPayload);
    }
  }

  return {
    rowsInserted,
    rowsUpdated,
    rowsSkipped,
    observationsReceived,
    errors,
  };
}

/**
 * Fetch a single FRED-sourced indicator, persist observations with revision handling,
 * and write a fetch log row.
 */
export async function fetchFredIndicator(
  params: FetchFredIndicatorParams,
): Promise<FetchFredIndicatorResult> {
  const indicator = await loadFredIndicator(params.indicatorCode);
  const { dateFrom, dateTo } = await resolveDateRange(
    indicator.id,
    params.dateFrom,
    params.dateTo,
  );

  const log = await dataFetchLogRepository.start({
    jobName: `fetch_fred_${indicator.code.toLowerCase()}`,
    triggerType: params.triggerType,
    triggeredBy: params.triggeredBy ?? null,
    targetDateFrom: dateFrom,
    targetDateTo: dateTo,
    metadata: {
      indicatorCode: indicator.code,
      seriesId: indicator.sourceSeriesId,
    },
  });

  try {
    let run: IngestionRunResult;

    if (indicator.code === US_02Y_SMA_CODE) {
      run = await fetchFredIndicatorWithSmaTransform(
        indicator,
        dateFrom,
        dateTo,
        log.id,
        US_02Y_SMA_WINDOW,
      );
    } else {
      const fetchResult = await fredClient.getSeriesObservations({
        seriesId: indicator.sourceSeriesId as string,
        observationStart: toIsoDate(dateFrom),
        observationEnd: toIsoDate(dateTo),
      });
      run = await ingestGenericObservations(indicator, fetchResult.observations, log.id);
    }

    const status: 'success' | 'partial' = run.errors.length === 0 ? 'success' : 'partial';

    await dataFetchLogRepository.complete({
      logId: log.id,
      status,
      rowsInserted: run.rowsInserted,
      rowsUpdated: run.rowsUpdated,
      rowsSkipped: run.rowsSkipped,
      errors: run.errors.length > 0 ? (run.errors as unknown as object) : undefined,
    });

    return {
      indicatorCode: indicator.code,
      logId: log.id,
      status,
      rowsInserted: run.rowsInserted,
      rowsUpdated: run.rowsUpdated,
      rowsSkipped: run.rowsSkipped,
      observationsReceived: run.observationsReceived,
      dateFrom: toIsoDate(dateFrom),
      dateTo: toIsoDate(dateTo),
      errors: run.errors.length > 0 ? run.errors : undefined,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof AppError ? err.code : 'UNKNOWN',
    };
    logger.error({ ...errorPayload, indicatorCode: indicator.code }, 'FRED fetch failed');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      errors: [errorPayload] as unknown as object,
    });

    return {
      indicatorCode: indicator.code,
      logId: log.id,
      status: 'failed',
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      observationsReceived: 0,
      dateFrom: toIsoDate(dateFrom),
      dateTo: toIsoDate(dateTo),
      errors: [errorPayload],
    };
  }
}

/**
 * Fetch all FRED-sourced indicators. Used by the cron orchestrator.
 * Failures of individual indicators do not block others.
 */
export async function fetchAllFredIndicators(
  triggerType: 'cron' | 'manual' | 'backfill',
  triggeredBy?: string | null,
): Promise<FetchFredIndicatorResult[]> {
  const indicators = await prisma.indicator.findMany({
    where: { dataSource: 'fred', isActive: true },
    select: { code: true },
  });

  const results: FetchFredIndicatorResult[] = [];
  for (const ind of indicators) {
    try {
      const result = await fetchFredIndicator({
        indicatorCode: ind.code,
        triggerType,
        triggeredBy: triggeredBy ?? null,
      });
      results.push(result);
    } catch (err) {
      logger.error({ indicatorCode: ind.code, err }, 'Fatal error fetching FRED indicator');
    }
  }
  return results;
}

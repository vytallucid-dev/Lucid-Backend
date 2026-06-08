import { Indicator } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import type { EodhdDataPoint } from '@core/clients/eodhd/types';

const DEFAULT_BACKFILL_DAYS = 60;
const REVISION_BUFFER_DAYS = 30;

// The EODHD commodities endpoint (BRENT) ignores `from` and returns full history
// (~480 rows) every fetch, unlike the EOD endpoint (DXY, USD/INR) which honors it.
// Cap the commodity series to the most recent N points before the write loop so a
// Brent fetch doesn't rewrite hundreds of unchanged rows (and run ~10 min) each
// time. 30 comfortably covers the 10-day rolling-direction calc — which reads
// accumulated DB history and needs lookback+1 = 11 points — so it can't truncate
// scoring even on a cold start.
const COMMODITY_RECENT_WINDOW = 30;

type EodhdEndpointKind = 'eod' | 'commodity';

interface EodhdIndicatorConfig {
  kind: EodhdEndpointKind;
  symbol: string;
}

/**
 * NIFTY-specific mapping: indicator code → EODHD endpoint + symbol. The generic
 * EODHD client (core/clients/eodhd) takes any symbol and is endpoint-agnostic;
 * THIS map is what makes the NIFTY job NIFTY-aware (and why the client stays
 * reusable by EdgeFinder, which will define its own mapping for its series).
 *
 * Endpoint kind cannot be derived from the symbol alone (e.g. "BRENT" doesn't
 * self-identify as a commodity), so it is declared explicitly here.
 */
const EODHD_INDICATOR_CONFIG: Record<string, EodhdIndicatorConfig> = {
  IND_NIFTY_10_DXY: { kind: 'eod', symbol: 'DXY.INDX' },
  IND_NIFTY_11_BRENT: { kind: 'commodity', symbol: 'BRENT' },
  IND_NIFTY_12_USDINR: { kind: 'eod', symbol: 'USDINR.FOREX' },
};

export interface FetchEodhdIndicatorParams {
  indicatorCode: string;
  dateFrom?: Date;
  dateTo?: Date;
  triggerType: 'cron' | 'manual' | 'backfill';
  triggeredBy?: string | null;
}

export interface FetchEodhdIndicatorResult {
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

async function loadEodhdIndicator(indicatorCode: string): Promise<Indicator> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: indicatorCode },
  });

  if (!indicator) {
    throw new AppError(404, `Indicator not found: ${indicatorCode}`, 'INDICATOR_NOT_FOUND');
  }

  if (indicator.dataSource !== 'eodhd') {
    throw new AppError(
      400,
      `Indicator ${indicatorCode} is not an EODHD-sourced indicator (data_source=${indicator.dataSource})`,
      'INVALID_DATA_SOURCE',
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

  // Smart catch-up: pull from (latest - buffer) or default backfill window.
  const latest = await dataPointsRepository.getLatestObservationDate(indicatorId);

  if (latest) {
    const dateFrom = new Date(latest);
    dateFrom.setDate(dateFrom.getDate() - REVISION_BUFFER_DAYS);
    return { dateFrom, dateTo };
  }

  // No existing data — default backfill (enough to cover the 10-day rolling window).
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - DEFAULT_BACKFILL_DAYS);
  return { dateFrom, dateTo };
}

async function fetchPriorValue(indicatorId: string, beforeDate: Date): Promise<number | null> {
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

function fetchSeriesForConfig(config: EodhdIndicatorConfig, fromIso: string): Promise<EodhdDataPoint[]> {
  return config.kind === 'commodity'
    ? eodhdClient.fetchCommoditySeries(config.symbol, fromIso)
    : eodhdClient.fetchEodSeries(config.symbol, fromIso);
}

/**
 * Persist each normalized point as-is, chaining previous_value from the running
 * last-seen value (DB prior on the first point). Mirrors the FRED generic
 * ingestion path; the client returns numbers already sorted ascending, so there
 * is no string-value parsing here.
 */
async function ingestPoints(
  indicator: Indicator,
  config: EodhdIndicatorConfig,
  points: EodhdDataPoint[],
  dateTo: Date,
  logId: string,
): Promise<IngestionRunResult> {
  const observationsReceived = points.length;
  const dateToIso = toIsoDate(dateTo);

  // Defensive: client already sorts ascending; clamp to the upper bound (manual
  // runs may pass a date_to).
  const sorted = [...points]
    .filter((p) => p.date <= dateToIso)
    .sort((a, b) => a.date.localeCompare(b.date));

  let rowsInserted = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;
  const errors: unknown[] = [];

  let lastSeenValue: number | null = null;
  if (sorted.length > 0) {
    const firstObsDate = new Date(`${sorted[0].date}T00:00:00.000Z`);
    lastSeenValue = await fetchPriorValue(indicator.id, firstObsDate);
  }

  for (const point of sorted) {
    if (!Number.isFinite(point.value)) {
      rowsSkipped += 1;
      continue;
    }

    try {
      const observationDate = new Date(`${point.date}T00:00:00.000Z`);
      const result = await dataPointsRepository.upsert({
        indicatorId: indicator.id,
        observationDate,
        value: point.value,
        forecastValue: null,
        previousValue: lastSeenValue,
        source: 'eodhd',
        sourceMetadata: {
          provider: 'eodhd',
          symbol: config.symbol,
          endpoint: config.kind,
        },
        fetchedVia: logId,
      });

      if (result.action === 'inserted') rowsInserted += 1;
      else if (result.action === 'revised') rowsUpdated += 1;
      else rowsSkipped += 1;

      // Chain forward — this value is the canonical "previous" for the next point.
      lastSeenValue = point.value;
    } catch (err) {
      const errorPayload = {
        observationDate: point.date,
        rawValue: point.value,
        message: err instanceof Error ? err.message : String(err),
      };
      logger.error(
        { ...errorPayload, indicatorCode: indicator.code },
        'Failed to upsert EODHD observation',
      );
      errors.push(errorPayload);
    }
  }

  return { rowsInserted, rowsUpdated, rowsSkipped, observationsReceived, errors };
}

/**
 * Fetch a single EODHD-sourced indicator, persist points with revision handling,
 * and write a `fetch_eodhd_<code>` fetch log row. Mirrors fetchFredIndicator.
 */
export async function fetchEodhdIndicator(
  params: FetchEodhdIndicatorParams,
): Promise<FetchEodhdIndicatorResult> {
  const indicator = await loadEodhdIndicator(params.indicatorCode);

  const config = EODHD_INDICATOR_CONFIG[indicator.code];
  if (!config) {
    throw new AppError(
      500,
      `No EODHD endpoint config for indicator ${indicator.code}`,
      'EODHD_CONFIG_MISSING',
      { indicatorCode: indicator.code },
    );
  }

  const { dateFrom, dateTo } = await resolveDateRange(indicator.id, params.dateFrom, params.dateTo);

  const log = await dataFetchLogRepository.start({
    jobName: `fetch_eodhd_${indicator.code.toLowerCase()}`,
    triggerType: params.triggerType,
    triggeredBy: params.triggeredBy ?? null,
    targetDateFrom: dateFrom,
    targetDateTo: dateTo,
    metadata: {
      indicatorCode: indicator.code,
      symbol: config.symbol,
      endpoint: config.kind,
    },
  });

  try {
    const points = await fetchSeriesForConfig(config, toIsoDate(dateFrom));

    // Commodity path only: don't trust the endpoint's `from` — it returns full
    // history regardless. `points` is sorted ascending, so the tail is the most
    // recent window. The EOD path (DXY, USD/INR) already returns a small
    // `from`-limited series and is left as-is.
    const windowed =
      config.kind === 'commodity' ? points.slice(-COMMODITY_RECENT_WINDOW) : points;

    const run = await ingestPoints(indicator, config, windowed, dateTo, log.id);

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
    logger.error({ ...errorPayload, indicatorCode: indicator.code }, 'EODHD fetch failed');

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
 * Fetch all active EODHD-sourced NIFTY indicators. Used by the cron orchestrator
 * and the manual /jobs/run trigger. Scoped to tool='nifty' so EdgeFinder's
 * future EODHD series (which will have their own job) are not pulled in here.
 * Failures of individual indicators do not block others.
 */
export async function fetchAllEodhdIndicators(
  triggerType: 'cron' | 'manual' | 'backfill',
  triggeredBy?: string | null,
): Promise<FetchEodhdIndicatorResult[]> {
  const indicators = await prisma.indicator.findMany({
    where: { dataSource: 'eodhd', tool: 'nifty', isActive: true },
    select: { code: true },
  });

  const results: FetchEodhdIndicatorResult[] = [];
  for (const ind of indicators) {
    try {
      const result = await fetchEodhdIndicator({
        indicatorCode: ind.code,
        triggerType,
        triggeredBy: triggeredBy ?? null,
      });
      results.push(result);
    } catch (err) {
      logger.error({ indicatorCode: ind.code, err }, 'Fatal error fetching EODHD indicator');
    }
  }
  return results;
}

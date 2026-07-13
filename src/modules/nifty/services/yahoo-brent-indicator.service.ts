import { Indicator } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { yahooClient, YahooDailyRow } from '@core/clients/yahoo/yahoo.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';

const BRENT_INDICATOR_CODE = 'IND_NIFTY_11_BRENT';
const BRENT_SYMBOL = 'BZ=F';

// Covers the 10-day scoring window plus buffer for weekends/holidays where Yahoo
// has no trading day; the DB already holds older history so only the newest end
// needs to arrive here.
const BRENT_FETCH_DAYS_BACK = 15;

// If the newly-fetched close is identical to the last N consecutive stored
// values, the feed looks frozen (this is exactly how the prior Crude Price API
// and EODHD commodity sources failed). The row is still written — this is an
// alert, not a block — but the fetch-log status is downgraded to 'partial' so
// it surfaces in the admin logs the frontend already renders.
const BRENT_STALENESS_CONSECUTIVE_THRESHOLD = 5;

export interface FetchYahooBrentParams {
  triggerType: 'cron' | 'manual' | 'backfill';
  triggeredBy?: string | null;
}

export interface FetchYahooBrentResult {
  indicatorCode: string;
  logId: string;
  status: 'success' | 'partial' | 'failed';
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  observationDate: string | null;
  value: number | null;
  staleWarning: boolean;
  errors?: unknown[];
}

async function loadBrentIndicator(): Promise<Indicator> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: BRENT_INDICATOR_CODE },
  });

  if (!indicator) {
    throw new AppError(404, `Indicator not found: ${BRENT_INDICATOR_CODE}`, 'INDICATOR_NOT_FOUND');
  }

  if (indicator.dataSource !== 'yahoo') {
    throw new AppError(
      400,
      `Indicator ${BRENT_INDICATOR_CODE} is not a Yahoo indicator (data_source=${indicator.dataSource})`,
      'INVALID_DATA_SOURCE',
    );
  }

  return indicator;
}

/** Most recent existing Brent value strictly before `beforeDate` (current vintages only). */
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

/**
 * Detect whether `newValue` matches the last `BRENT_STALENESS_CONSECUTIVE_THRESHOLD`
 * consecutive stored values (current vintages, strictly before `beforeDate`). Returns
 * the matched dates for logging if frozen, otherwise an empty array.
 */
async function detectFrozenFeed(
  indicatorId: string,
  beforeDate: Date,
  newValue: number,
): Promise<{ isFrozen: boolean; matchedDates: string[] }> {
  const recent = await prisma.dataPoint.findMany({
    where: {
      indicatorId,
      isCurrent: true,
      observationDate: { lt: beforeDate },
    },
    orderBy: { observationDate: 'desc' },
    take: BRENT_STALENESS_CONSECUTIVE_THRESHOLD,
    select: { value: true, observationDate: true },
  });

  if (recent.length < BRENT_STALENESS_CONSECUTIVE_THRESHOLD) {
    return { isFrozen: false, matchedDates: [] };
  }

  const allMatch = recent.every((row) => Number(row.value) === newValue);
  if (!allMatch) {
    return { isFrozen: false, matchedDates: [] };
  }

  return {
    isFrozen: true,
    matchedDates: recent.map((row) => row.observationDate.toISOString().slice(0, 10)),
  };
}

/**
 * Fetch BZ=F (Brent futures) daily history from Yahoo Finance and persist exactly
 * ONE vintage-aware data point for IND_NIFTY_11_BRENT — the most recent complete
 * trading day's close — writing a `fetch_yahoo_brent` fetch-log row. Mirrors
 * fetchCrudeBrentIndicator's plumbing (same dataPointsRepository upsert, same
 * data_fetch_log) but sources from yahooClient instead, and adds a Brent-only
 * staleness guard (see detectFrozenFeed) since the two prior Brent sources both
 * silently froze.
 *
 * Called by BOTH the orchestrator job (runYahooBrentFetch) and the manual
 * /fetch-fred-indicator/run route for data_source 'yahoo'.
 */
export async function fetchYahooBrentIndicator(
  params: FetchYahooBrentParams,
): Promise<FetchYahooBrentResult> {
  const indicator = await loadBrentIndicator();

  const log = await dataFetchLogRepository.start({
    jobName: 'fetch_yahoo_brent',
    triggerType: params.triggerType,
    triggeredBy: params.triggeredBy ?? null,
    metadata: {
      indicatorCode: indicator.code,
      provider: 'yahoo',
      symbol: BRENT_SYMBOL,
    },
  });

  try {
    const rows = await yahooClient.fetchDailyHistory({
      symbol: BRENT_SYMBOL,
      daysBack: BRENT_FETCH_DAYS_BACK,
    });

    const latest: YahooDailyRow = rows[rows.length - 1];
    const observationDate = new Date(`${latest.date}T00:00:00.000Z`);
    const previousValue = await fetchPriorValue(indicator.id, observationDate);

    const { isFrozen, matchedDates } = await detectFrozenFeed(
      indicator.id,
      observationDate,
      latest.close,
    );

    if (isFrozen) {
      logger.warn(
        {
          indicatorCode: indicator.code,
          value: latest.close,
          observationDate: latest.date,
          matchedDates,
          threshold: BRENT_STALENESS_CONSECUTIVE_THRESHOLD,
        },
        `Brent value unchanged for ${BRENT_STALENESS_CONSECUTIVE_THRESHOLD} consecutive days — possible frozen feed`,
      );
    }

    const result = await dataPointsRepository.upsert({
      indicatorId: indicator.id,
      observationDate,
      value: latest.close,
      forecastValue: null,
      previousValue,
      source: 'yahoo',
      sourceMetadata: {
        provider: 'yahoo',
        symbol: BRENT_SYMBOL,
        instrument: 'brent_futures',
      },
      fetchedVia: log.id,
    });

    const rowsInserted = result.action === 'inserted' ? 1 : 0;
    const rowsUpdated = result.action === 'revised' ? 1 : 0;
    const rowsSkipped = result.action === 'skipped' ? 1 : 0;

    const status: FetchYahooBrentResult['status'] = isFrozen ? 'partial' : 'success';

    await dataFetchLogRepository.complete({
      logId: log.id,
      status,
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      ...(isFrozen && {
        errors: [
          {
            code: 'BRENT_FEED_POSSIBLY_FROZEN',
            message: `Brent value ${latest.close} unchanged for ${BRENT_STALENESS_CONSECUTIVE_THRESHOLD} consecutive days`,
            matchedDates,
          },
        ] as unknown as object,
      }),
    });

    logger.info(
      {
        indicatorCode: indicator.code,
        observationDate: latest.date,
        value: latest.close,
        action: result.action,
        status,
      },
      'Yahoo Brent fetch complete',
    );

    return {
      indicatorCode: indicator.code,
      logId: log.id,
      status,
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      observationDate: latest.date,
      value: latest.close,
      staleWarning: isFrozen,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof AppError ? err.code : 'UNKNOWN',
    };
    logger.error({ ...errorPayload, indicatorCode: indicator.code }, 'Yahoo Brent fetch failed');

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
      observationDate: null,
      value: null,
      staleWarning: false,
      errors: [errorPayload],
    };
  }
}

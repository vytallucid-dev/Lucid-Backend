import { Indicator } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { crudePriceClient } from '@core/clients/crude-price/crude-price.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';

const BRENT_INDICATOR_CODE = 'IND_NIFTY_11_BRENT';

// IST is UTC+5:30. The NIFTY tool keys "today" off the India trading calendar, so
// a Brent point is dated by the IST calendar date of its source timestamp — not
// the UTC date — matching todayInIstAsUtcMidnight() used by the NSE jobs.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface FetchCrudeBrentParams {
  triggerType: 'cron' | 'manual' | 'backfill';
  triggeredBy?: string | null;
}

export interface FetchCrudeBrentResult {
  indicatorCode: string;
  logId: string;
  status: 'success' | 'failed';
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  observationDate: string | null;
  value: number | null;
  errors?: unknown[];
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Derive the observation date (UTC-midnight of the IST calendar date) from the
 * API's `created_at` timestamp: shift the UTC instant by +5:30 and keep Y-M-D.
 */
function toIstObservationDate(observedAt: string): Date {
  const ist = new Date(new Date(observedAt).getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

async function loadBrentIndicator(): Promise<Indicator> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: BRENT_INDICATOR_CODE },
  });

  if (!indicator) {
    throw new AppError(404, `Indicator not found: ${BRENT_INDICATOR_CODE}`, 'INDICATOR_NOT_FOUND');
  }

  if (indicator.dataSource !== 'crude_price_api') {
    throw new AppError(
      400,
      `Indicator ${BRENT_INDICATOR_CODE} is not a Crude Price API indicator (data_source=${indicator.dataSource})`,
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
 * Fetch today's Brent spot price from the Crude Price API and persist exactly ONE
 * vintage-aware data point for IND_NIFTY_11_BRENT, writing a `fetch_crude_brent`
 * fetch-log row. Mirrors fetchEodhdIndicator's plumbing (same dataPointsRepository
 * upsert, same data_fetch_log) but does NOT loop over history: the older end of
 * the 10-day rolling window comes from the existing DB history (prior EODHD runs);
 * /latest only supplies the current end, so the window self-heals over ~10 days.
 *
 * Called by BOTH the orchestrator job (runCrudeBrentFetch) and the manual
 * /fetch-fred-indicator/run route for data_source 'crude_price_api'.
 */
export async function fetchCrudeBrentIndicator(
  params: FetchCrudeBrentParams,
): Promise<FetchCrudeBrentResult> {
  const indicator = await loadBrentIndicator();

  const log = await dataFetchLogRepository.start({
    jobName: 'fetch_crude_brent',
    triggerType: params.triggerType,
    triggeredBy: params.triggeredBy ?? null,
    metadata: {
      indicatorCode: indicator.code,
      provider: 'crudepriceapi',
      endpoint: 'latest',
    },
  });

  try {
    const latest = await crudePriceClient.fetchLatestBrent();
    const observationDate = toIstObservationDate(latest.observedAt);
    const previousValue = await fetchPriorValue(indicator.id, observationDate);

    const result = await dataPointsRepository.upsert({
      indicatorId: indicator.id,
      observationDate,
      value: latest.price,
      forecastValue: null,
      previousValue,
      source: 'crude_price_api',
      sourceMetadata: {
        provider: 'crudepriceapi',
        endpoint: 'latest',
        code: 'BRENT_CRUDE_USD',
      },
      fetchedVia: log.id,
    });

    const rowsInserted = result.action === 'inserted' ? 1 : 0;
    const rowsUpdated = result.action === 'revised' ? 1 : 0;
    const rowsSkipped = result.action === 'skipped' ? 1 : 0;

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
        value: latest.price,
        action: result.action,
      },
      'Crude Price Brent fetch complete',
    );

    return {
      indicatorCode: indicator.code,
      logId: log.id,
      status: 'success',
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      observationDate: toIsoDate(observationDate),
      value: latest.price,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof AppError ? err.code : 'UNKNOWN',
    };
    logger.error({ ...errorPayload, indicatorCode: indicator.code }, 'Crude Price Brent fetch failed');

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
      errors: [errorPayload],
    };
  }
}

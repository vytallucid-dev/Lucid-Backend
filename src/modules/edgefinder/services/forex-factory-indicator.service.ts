import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { forexFactoryClient } from '@core/clients/forex-factory/forex-factory.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import type { ForexFactoryEvent } from '@core/clients/forex-factory/types';
import { mapEventToIndicator } from './forex-factory-event-mapping';
import { parseForexFactoryValue } from './forex-factory-value-parser';
import { getPriorRateLevel } from './rate-decision.helpers';

const JOB_NAME = 'forex_factory_weekly_fetch';

export interface FetchForexFactoryResult {
  logId: string;
  status: 'success' | 'partial' | 'failed';
  totalEvents: number;
  mappedCount: number;
  /** Mapped events persisted with a usable actual (inserted/revised/unchanged). */
  writtenWithActual: number;
  /** Mapped events persisted with forecast+previous but actual still pending. */
  writtenForecastOnly: number;
  /** Mapped events skipped this run because no usable actual was published yet. */
  mappedDeferredCount: number;
  unmappedCount: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  errors: unknown[];
  unmappedEvents: Array<{ title: string; country: string }>;
  /** Mapped events skipped this run (no usable actual yet) — surfaced so deferrals aren't silent. */
  deferredEvents: Array<{ title: string; country: string; date: string }>;
}

export interface MissingValueResolution {
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  skipEntireEvent: boolean;
}

export function detectMissingValues(event: ForexFactoryEvent): MissingValueResolution {
  // Rule 1: `actual` omitted or empty → future release, skip entirely
  if (event.actual === undefined || event.actual === '') {
    return { actual: null, forecast: null, previous: null, skipEntireEvent: true };
  }

  // Rule 2: parse all three; nulls mean missing
  const actual = parseForexFactoryValue(event.actual);
  const forecast = parseForexFactoryValue(event.forecast);
  const previous = parseForexFactoryValue(event.previous);

  // Rule 3: unusable actual → skip
  if (actual === null) {
    return { actual: null, forecast: null, previous: null, skipEntireEvent: true };
  }

  return { actual, forecast, previous, skipEntireEvent: false };
}

export function parseForexFactoryDate(dateStr: string): Date {
  const fullDate = new Date(dateStr);
  if (Number.isNaN(fullDate.getTime())) {
    throw new Error(`Invalid Forex Factory date: ${dateStr}`);
  }
  return new Date(
    Date.UTC(
      fullDate.getUTCFullYear(),
      fullDate.getUTCMonth(),
      fullDate.getUTCDate(),
    ),
  );
}

interface IngestOneOutcome {
  action: 'inserted' | 'revised' | 'skipped';
}

function buildSourceMetadata(event: ForexFactoryEvent): Prisma.InputJsonObject {
  return {
    ffTitle: event.title,
    ffCountry: event.country,
    ffDate: event.date,
    ffImpact: event.impact,
    ffActualRaw: event.actual ?? null,
    ffForecastRaw: event.forecast ?? null,
    ffPreviousRaw: event.previous ?? null,
    ffUrl: event.url ?? null,
  };
}

async function ingestRateDecision(
  indicatorId: string,
  indicatorCode: string,
  observationDate: Date,
  newRateLevel: number,
  event: ForexFactoryEvent,
  logId: string,
): Promise<IngestOneOutcome> {
  const priorRate = await getPriorRateLevel(indicatorId, observationDate);
  const firstRelease = priorRate === null;
  const bpsChange = firstRelease ? 0 : (newRateLevel - priorRate) * 100;

  const sourceMetadata: Prisma.InputJsonObject = {
    ...buildSourceMetadata(event),
    rate_level: newRateLevel,
    ...(firstRelease ? { first_release: true } : {}),
  };

  const result = await dataPointsRepository.upsert({
    indicatorId,
    observationDate,
    value: bpsChange,
    forecastValue: null,
    source: 'forex_factory',
    sourceMetadata,
    fetchedVia: logId,
  });

  logger.debug(
    {
      indicatorCode,
      observationDate: observationDate.toISOString(),
      newRateLevel,
      priorRate,
      bpsChange,
      action: result.action,
    },
    'ForexFactory: rate decision ingested',
  );

  return { action: result.action };
}

async function ingestRegularEvent(
  indicatorId: string,
  indicatorCode: string,
  observationDate: Date,
  resolved: MissingValueResolution,
  event: ForexFactoryEvent,
  logId: string,
): Promise<IngestOneOutcome> {
  if (resolved.actual === null) {
    return { action: 'skipped' };
  }

  const sourceMetadata = buildSourceMetadata(event);

  const result = await dataPointsRepository.upsert({
    indicatorId,
    observationDate,
    value: resolved.actual,
    forecastValue: resolved.forecast,
    previousValue: resolved.previous,
    source: 'forex_factory',
    sourceMetadata,
    fetchedVia: logId,
  });

  logger.debug(
    {
      indicatorCode,
      observationDate: observationDate.toISOString(),
      value: resolved.actual,
      forecast: resolved.forecast,
      previous: resolved.previous,
      action: result.action,
    },
    'ForexFactory: event ingested',
  );

  return { action: result.action };
}

export async function fetchForexFactoryWeek(
  triggerType: 'cron' | 'manual' | 'backfill',
  triggeredBy?: string | null,
): Promise<FetchForexFactoryResult> {
  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType,
    triggeredBy: triggeredBy ?? null,
    metadata: { endpoint: 'week' },
  });

  let totalEvents = 0;
  let mappedCount = 0;
  let writtenWithActual = 0;
  let writtenForecastOnly = 0;
  let mappedDeferredCount = 0;
  let unmappedCount = 0;
  let rowsInserted = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;
  const errors: unknown[] = [];
  const unmappedEvents: Array<{ title: string; country: string }> = [];
  const deferredEvents: Array<{ title: string; country: string; date: string }> = [];

  try {
    const fetchResult = await forexFactoryClient.getCalendarWeek();
    totalEvents = fetchResult.events.length;

    const codes = new Set<string>();
    for (const event of fetchResult.events) {
      const code = mapEventToIndicator(event.country, event.title);
      if (code) codes.add(code);
    }
    const indicators = codes.size
      ? await prisma.indicator.findMany({
          where: { code: { in: Array.from(codes) } },
          select: { id: true, code: true },
        })
      : [];
    const codeToId = new Map(indicators.map((i) => [i.code, i.id]));

    for (const event of fetchResult.events) {
      const indicatorCode = mapEventToIndicator(event.country, event.title);

      if (!indicatorCode) {
        unmappedCount += 1;
        unmappedEvents.push({ title: event.title, country: event.country });
        logger.info(
          {
            unmapped_event: true,
            title: event.title,
            country: event.country,
            impact: event.impact,
          },
          'ForexFactory: unmapped event',
        );
        continue;
      }

      const indicatorId = codeToId.get(indicatorCode);
      if (!indicatorId) {
        rowsSkipped += 1;
        const payload = {
          indicatorCode,
          title: event.title,
          message: 'Indicator code mapped but indicator row not found in DB',
        };
        logger.warn(payload, 'ForexFactory: indicator missing in DB');
        errors.push(payload);
        continue;
      }

      mappedCount += 1;

      const resolved = detectMissingValues(event);
      if (resolved.skipEntireEvent) {
        // No usable actual yet — defer (don't write a row). Surface it so the
        // deferral is visible (the twice-daily timing should pick up the actual
        // on a later same-week run once the release publishes).
        mappedDeferredCount += 1;
        deferredEvents.push({ title: event.title, country: event.country, date: event.date });
        logger.info(
          {
            deferred_event: true,
            indicatorCode,
            title: event.title,
            country: event.country,
            date: event.date,
            impact: event.impact,
          },
          'ForexFactory: deferred event (actual not published yet)',
        );
        continue;
      }

      try {
        const observationDate = parseForexFactoryDate(event.date);
        const isRateDecision = indicatorCode.endsWith('_RATE');

        const outcome = isRateDecision
          ? await ingestRateDecision(
              indicatorId,
              indicatorCode,
              observationDate,
              resolved.actual as number,
              event,
              log.id,
            )
          : await ingestRegularEvent(
              indicatorId,
              indicatorCode,
              observationDate,
              resolved,
              event,
              log.id,
            );

        if (outcome.action === 'inserted') rowsInserted += 1;
        else if (outcome.action === 'revised') rowsUpdated += 1;
        else rowsSkipped += 1;

        // Reached the ingest path → event had a usable actual and is now persisted
        // (whether newly written or already present/unchanged).
        writtenWithActual += 1;
      } catch (err) {
        const errorPayload = {
          indicatorCode,
          title: event.title,
          eventDate: event.date,
          message: err instanceof Error ? err.message : String(err),
        };
        logger.error(errorPayload, 'ForexFactory: failed to ingest event');
        errors.push(errorPayload);
      }
    }

    const status: 'success' | 'partial' = errors.length === 0 ? 'success' : 'partial';

    await dataFetchLogRepository.complete({
      logId: log.id,
      status,
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      errors: errors.length > 0 ? (errors as unknown as object) : undefined,
      metadata: {
        endpoint: 'week',
        totalEvents,
        mappedCount,
        writtenWithActual,
        writtenForecastOnly,
        deferredCount: mappedDeferredCount,
        unmappedCount,
        rowsInserted,
        rowsUpdated,
        rowsSkipped,
        unmappedEvents,
        deferredEvents,
      },
    });

    return {
      logId: log.id,
      status,
      totalEvents,
      mappedCount,
      writtenWithActual,
      writtenForecastOnly,
      mappedDeferredCount,
      unmappedCount,
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      errors,
      unmappedEvents,
      deferredEvents,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    logger.error({ ...errorPayload, jobName: JOB_NAME }, 'ForexFactory weekly fetch failed');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      errors: [errorPayload] as unknown as object,
      metadata: {
        endpoint: 'week',
        totalEvents,
        mappedCount,
        writtenWithActual,
        writtenForecastOnly,
        deferredCount: mappedDeferredCount,
        unmappedCount,
        rowsInserted,
        rowsUpdated,
        rowsSkipped,
        unmappedEvents,
        deferredEvents,
      },
    });

    return {
      logId: log.id,
      status: 'failed',
      totalEvents,
      mappedCount,
      writtenWithActual,
      writtenForecastOnly,
      mappedDeferredCount,
      unmappedCount,
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      errors: [errorPayload],
      unmappedEvents,
      deferredEvents,
    };
  }
}

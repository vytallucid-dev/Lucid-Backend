import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { forexFactoryClient } from '@core/clients/forex-factory/forex-factory.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import type { ForexFactoryEvent } from '@core/clients/forex-factory/types';
import { resolveEvent } from './forex-factory-event-mapping';
import { parseForexFactoryValue } from './forex-factory-value-parser';
import { calendarEventsRepository } from '@core/repositories/calendar-events.repository';
import { getPriorRateLevel, levelToBpsChange } from './rate-decision.helpers';

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
  /** Mapped events with no usable actual yet — no DataPoint written, event still stored. */
  mappedDeferredCount: number;
  unmappedCount: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  /** B3: calendar_events occurrences written this run (mapped AND unmapped). */
  calendarInserted: number;
  calendarUpdated: number;
  errors: unknown[];
  unmappedEvents: Array<{ title: string; country: string }>;
  /** Mapped events skipped this run (no usable actual yet) — surfaced so deferrals aren't silent. */
  deferredEvents: Array<{ title: string; country: string; date: string }>;
}

export interface MissingValueResolution {
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  /**
   * B1: renamed from `skipEntireEvent`. A missing actual now means only that
   * NO SCORE CAN BE COMPUTED — it never means the event is discarded. The
   * occurrence is still stored in calendar_events with its date, forecast,
   * previous and impact intact.
   *
   * Consumers must read this as "don't write a DataPoint", nothing more.
   */
  noActualYet: boolean;
}

/**
 * Parse an event's three numeric fields.
 *
 * B1 — THE DISCARD BUG. This function previously returned all three values as
 * null whenever `actual` was absent, throwing away a perfectly good forecast,
 * previous and date. That was catastrophic in practice rather than in theory:
 * ff_calendar_thisweek.json is a FORWARD schedule and omits the `actual` key
 * entirely on unreleased events — a live 99-event fetch had zero events
 * carrying `actual`. Every event therefore hit this branch, and
 * `SELECT count(*) FROM data_points WHERE source = 'forex_factory'` was 0
 * across the pipeline's whole lifetime.
 *
 * forecast and previous are now parsed and returned unconditionally. Only the
 * DataPoint write is gated on a usable actual.
 */
export function detectMissingValues(event: ForexFactoryEvent): MissingValueResolution {
  // Parse all three independently. A null on any one of them means only that
  // that particular field was missing or unparseable.
  const forecast = parseForexFactoryValue(event.forecast);
  const previous = parseForexFactoryValue(event.previous);

  // `actual` omitted, empty, or unparseable → the release has not published a
  // usable number yet. Scoring is deferred; the event itself is still stored.
  if (event.actual === undefined || event.actual === '') {
    return { actual: null, forecast, previous, noActualYet: true };
  }

  const actual = parseForexFactoryValue(event.actual);
  if (actual === null) {
    return { actual: null, forecast, previous, noActualYet: true };
  }

  return { actual, forecast, previous, noActualYet: false };
}

export type FetchStatus = 'success' | 'partial' | 'failed';

export interface RunStatusInputs {
  totalEvents: number;
  /** calendar_events rows inserted + updated this run. */
  calendarRowsWritten: number;
  mappedCount: number;
  unmappedCount: number;
  mappedDeferredCount: number;
  errorCount: number;
}

/**
 * B2 — decide a run's status from what it actually accomplished, not merely
 * from whether anything threw.
 *
 * Pure so the rules are testable without a database or a live feed.
 *
 * Ordering is deliberate: a run that wrote nothing is failed even if nothing
 * threw, because silent no-ops are precisely the failure this replaces.
 */
export function resolveRunStatus(i: RunStatusInputs): FetchStatus {
  // The feed returned nothing at all. Not a parse error, but not a working
  // pipeline either — a healthy week always has events.
  if (i.totalEvents === 0) return 'failed';

  // Events arrived and NONE were persisted. This is the exact shape of the
  // five green-but-empty runs that motivated B2.
  if (i.calendarRowsWritten === 0) return 'failed';

  // Nothing resolved to an indicator at all — the mapping table has drifted
  // completely away from the feed (a wholesale upstream rename, or a country
  // key that no longer matches). Events are stored, so no data is lost, but
  // the run has produced no scoreable output and must not read as healthy.
  if (i.mappedCount === 0) return 'failed';

  // Something threw mid-run: some events processed, some did not.
  if (i.errorCount > 0) return 'partial';

  // Unmapped events are expected in normal operation — the feed carries ~85
  // events a week that no EdgeFinder indicator tracks (NZD, CHF, CAD prints,
  // bond auctions, Fed speakers, and the deliberately-excluded euro-area
  // national sub-PMIs). They are stored in the unmapped queue for admin
  // review rather than treated as run failures. Deferrals are likewise
  // normal: the feed is a forward schedule, so a mapped event with no actual
  // yet is the common case, not an error.
  //
  // Both are surfaced as `partial` ONLY when they are total — i.e. when not a
  // single mapped event could be scored. That distinguishes "a normal week"
  // from "every release we track failed to publish", which warrants a look.
  if (i.mappedDeferredCount === i.mappedCount) return 'partial';

  return 'success';
}

/**
 * The feed sends ISO-8601 with an explicit offset (uniformly -04:00 in
 * observed data). `new Date()` parses that into the correct absolute instant,
 * which is exactly what calendar_events stores — no local-time string ever
 * touches the database, and the render layer converts to the viewer's zone.
 *
 * Distinct from parseForexFactoryDate below, which deliberately truncates to
 * a UTC calendar date for DataPoint.observationDate.
 */
export function parseForexFactoryInstant(dateStr: string): Date {
  const instant = new Date(dateStr);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Invalid Forex Factory date: ${dateStr}`);
  }
  return instant;
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

/**
 * Near-duplicate collapse window — same value as the repository's
 * NEAR_DUPLICATE_WINDOW_MS (calendar-events.repository.ts), which handles
 * the cross-fetch half of this same problem. Two constants rather than one
 * shared import because they answer the question at two different layers
 * (an in-memory array here, a stored-row lookup there) and a shared name
 * would suggest a coupling that doesn't otherwise exist between this service
 * and that repository — this file already depends on the repository through
 * its public upsert() contract, nothing more.
 */
const NEAR_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

function hasPopulatedFields(event: ForexFactoryEvent): boolean {
  return (event.forecast ?? '') !== '' || (event.previous ?? '') !== '';
}

/**
 * Collapse Forex Factory feed rows that are the SAME real-world release
 * reported twice within one fetch, before any of them reach upsert().
 *
 * THE PROBLEM THIS FIXES — US_ADP, observed live: two rows, identical title
 * ("ADP Weekly Employment Change"), identical country, scheduledAt 60
 * seconds apart, one with previousRaw: null (a placeholder) and one with
 * previousRaw: "15.0K" (the real row). The calendar_events natural key
 * (source, country, title, scheduledAt) treated them as two distinct
 * occurrences, correctly per its own definition — the assumption that ANY
 * distinct scheduledAt is a distinct occurrence is what breaks down here,
 * not the key itself.
 *
 * WHY GROUP BY (country, title) AND A TIME WINDOW, NOT JUST FIRST-WINS —
 * this must never merge two GENUINE same-day releases of the same title
 * (rare, but the mapping table's exact-string design already assumes title
 * collisions happen across countries every week — see the file header of
 * forex-factory-event-mapping.ts). A 5-minute window is wide enough to
 * absorb feed jitter and narrow enough that no real release schedule places
 * two distinct prints of the same series 5 minutes apart.
 *
 * WHY THIS NEVER TOUCHES COMPANION PAIRS (AU_RBA_RATE's "Cash Rate" /
 * "RBA Rate Statement", UK_GDP_MOM's "GDP m/m" / "Prelim GDP q/q") — the
 * group key is (country, title), an exact string match. Two different
 * titles that happen to map to the same indicator code never enter the same
 * group here; collapsing on title, not on resolved indicator code, is what
 * keeps this fix and the companion-event fix from interfering with each
 * other. Verified explicitly in the test suite, not merely assumed.
 *
 * WHY THIS NEVER TOUCHES A GENUINE RESCHEDULE — the same title moved by
 * hours or days is, by definition, outside the 5-minute window, so it never
 * groups with the original row and survives as two separate events, exactly
 * as intended (see the CalendarEvent model's own comment on this).
 *
 * MERGE RULE, mirrors the repository's cross-fetch merge exactly: within a
 * collapsed group, the row carrying forecast and/or previous is the real
 * one and survives; a row with neither is the placeholder and is dropped. If
 * every row in a group is a placeholder, or more than one carries populated
 * fields (never observed, but not impossible), the LATEST scheduledAt in the
 * group survives — the most recent information is the best guess when the
 * populated-fields signal doesn't disambiguate.
 */
export function collapseNearDuplicates(events: ForexFactoryEvent[]): ForexFactoryEvent[] {
  const groups = new Map<string, ForexFactoryEvent[]>();
  for (const event of events) {
    const key = `${event.country} ${event.title}`;
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }

  const survivors: ForexFactoryEvent[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }

    // Sort by instant so the window comparison and the "latest" tiebreaker
    // both walk the group in chronological order.
    const sorted = [...group].sort(
      (a, b) => parseForexFactoryInstant(a.date).getTime() - parseForexFactoryInstant(b.date).getTime(),
    );

    // Cluster adjacent rows within NEAR_DUPLICATE_WINDOW_MS of the cluster's
    // FIRST member (not the previous row) — chaining "within window of the
    // previous row" could let a slow drift of many small gaps merge rows
    // that are far apart overall. A group of two or three placeholder/real
    // rows for one release, the only case observed in practice, is
    // unaffected by this distinction; it only matters for pathological
    // inputs the feed has never actually sent.
    let clusterStart = sorted[0];
    let cluster: ForexFactoryEvent[] = [clusterStart];
    for (let i = 1; i < sorted.length; i++) {
      const instant = parseForexFactoryInstant(sorted[i].date).getTime();
      const withinWindow = instant - parseForexFactoryInstant(clusterStart.date).getTime() <= NEAR_DUPLICATE_WINDOW_MS;
      if (withinWindow) {
        cluster.push(sorted[i]);
        continue;
      }
      survivors.push(pickSurvivor(cluster));
      clusterStart = sorted[i];
      cluster = [clusterStart];
    }
    survivors.push(pickSurvivor(cluster));
  }

  return survivors;
}

/** One cluster's winner — see collapseNearDuplicates' MERGE RULE doc. */
function pickSurvivor(cluster: ForexFactoryEvent[]): ForexFactoryEvent {
  if (cluster.length === 1) return cluster[0];

  const populated = cluster.filter(hasPopulatedFields);
  if (populated.length === 1) return populated[0];

  // Zero or multiple populated rows: fall back to latest instant. cluster is
  // already chronologically sorted by the caller.
  return cluster[cluster.length - 1];
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
  expectedRateLevel: number | null,
  event: ForexFactoryEvent,
  logId: string,
): Promise<IngestOneOutcome> {
  const priorRate = await getPriorRateLevel(indicatorId, observationDate);
  const firstRelease = priorRate === null;
  const bpsChange = firstRelease ? 0 : (newRateLevel - priorRate) * 100;
  // Change 2 (rate decision scores surprise) — Step 1. FF publishes forecast
  // for a rate event as the expected absolute rate level, same as actual/
  // previous (see forex-factory-event-mapping.ts / the value parser). Convert
  // it to a bps-change delta against the SAME priorRate as `value`, so both
  // land in the same unit.
  const forecastBpsChange = levelToBpsChange(expectedRateLevel, priorRate);

  const sourceMetadata: Prisma.InputJsonObject = {
    ...buildSourceMetadata(event),
    rate_level: newRateLevel,
    ...(expectedRateLevel !== null ? { expected_rate_level: expectedRateLevel } : {}),
    ...(firstRelease ? { first_release: true } : {}),
  };

  const result = await dataPointsRepository.upsert({
    indicatorId,
    observationDate,
    value: bpsChange,
    forecastValue: forecastBpsChange,
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
      expectedRateLevel,
      forecastBpsChange,
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
  variant: string | null,
): Promise<IngestOneOutcome> {
  if (resolved.actual === null) {
    return { action: 'skipped' };
  }

  const sourceMetadata = buildSourceMetadata(event);

  const result = await dataPointsRepository.upsert({
    indicatorId,
    observationDate,
    variant,
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
      variant,
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
  let calendarInserted = 0;
  let calendarUpdated = 0;
  const errors: unknown[] = [];
  const unmappedEvents: Array<{ title: string; country: string }> = [];
  const deferredEvents: Array<{ title: string; country: string; date: string }> = [];

  try {
    const fetchResult = await forexFactoryClient.getCalendarWeek();
    // totalEvents reports what the feed actually sent, uncollapsed — this is
    // telemetry about the upstream fetch, not about how many occurrences get
    // written. The collapse below only changes what happens downstream.
    totalEvents = fetchResult.events.length;

    const events = collapseNearDuplicates(fetchResult.events);
    const collapsedCount = fetchResult.events.length - events.length;
    if (collapsedCount > 0) {
      logger.info(
        { jobName: JOB_NAME, collapsedCount, totalEvents },
        'ForexFactory: collapsed near-duplicate feed rows before ingest',
      );
    }

    const codes = new Set<string>();
    for (const event of events) {
      const resolution = resolveEvent(event.country, event.title);
      if (resolution) codes.add(resolution.code);
    }
    const indicators = codes.size
      ? await prisma.indicator.findMany({
          where: { code: { in: Array.from(codes) } },
          select: { id: true, code: true },
        })
      : [];
    const codeToId = new Map(indicators.map((i) => [i.code, i.id]));

    for (const event of events) {
      const resolution = resolveEvent(event.country, event.title);
      const indicatorCode = resolution?.code ?? null;
      const indicatorId = indicatorCode ? (codeToId.get(indicatorCode) ?? null) : null;

      // ---------------------------------------------------------------
      // B1/B3 — STORE THE OCCURRENCE FIRST, UNCONDITIONALLY.
      //
      // Every event is persisted to calendar_events before any decision
      // about scoring: mapped or unmapped, actual present or absent. The
      // feed is current-week-only (nextweek/lastweek both 404), so an event
      // not captured while it is "this week" is lost permanently. Storage is
      // therefore never contingent on whether we can score it.
      //
      // A failure here must not sink the whole run, so it is caught per
      // event and recorded as an error (which B2 then reflects in status).
      // ---------------------------------------------------------------
      const resolved = detectMissingValues(event);

      try {
        const calendarResult = await calendarEventsRepository.upsert({
          source: 'forex_factory',
          country: event.country,
          title: event.title,
          scheduledAt: parseForexFactoryInstant(event.date),
          impact: event.impact,
          // Reference only — never read by scoring. See the model comment.
          forecastRaw: event.forecast === '' ? null : event.forecast,
          previousRaw: event.previous === '' ? null : event.previous,
          actualRaw: event.actual === undefined || event.actual === '' ? null : event.actual,
          indicatorId,
          indicatorCode,
          variant: resolution?.variant ?? null,
          // Unmapped events (resolution null) are always primary — companion
          // is a designation ON a specific mapped title, meaningless without
          // a resolution to carry it.
          isPrimary: resolution?.isPrimary ?? true,
          fetchedVia: log.id,
        });
        if (calendarResult.action === 'inserted') calendarInserted += 1;
        else calendarUpdated += 1;
      } catch (err) {
        const payload = {
          title: event.title,
          country: event.country,
          eventDate: event.date,
          message: err instanceof Error ? err.message : String(err),
        };
        logger.error(payload, 'ForexFactory: failed to store calendar event');
        errors.push(payload);
      }

      // ---------------------------------------------------------------
      // Scoring path. Everything below decides whether a DataPoint is
      // written; none of it can un-store the occurrence above.
      // ---------------------------------------------------------------
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

      if (resolved.noActualYet) {
        // No usable actual yet, so no score can be computed. The occurrence
        // IS stored (above) with its date, forecast, previous and impact —
        // this only defers the DataPoint write. A later same-week run picks
        // up the actual once the release publishes.
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
          'ForexFactory: deferred scoring (actual not published yet); event stored',
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
              resolved.forecast,
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
              // B4: the release variant this feed string denotes (flash/final/
              // prelim/...), or null for a single-release indicator. Keeps
              // Flash and Final on separate rows for the same observationDate
              // rather than one silently overwriting the other. Rate decisions
              // have no variant ladder, so ingestRateDecision takes none.
              resolution?.variant ?? null,
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

    // ---------------------------------------------------------------
    // B2 — THE MONITORING LIE.
    //
    // Status was previously `errors.length === 0 ? 'success' : 'partial'`,
    // which consulted only thrown exceptions. Rows-written, deferrals and
    // unmapped events were all computed, written to metadata, and then
    // ignored by the decision. The observable result: five consecutive cron
    // runs reported `status=success` while writing 0 rows, mapping 15 of 99
    // events and deferring all 15 — with zero forex_factory DataPoints in the
    // database across the pipeline's entire lifetime. A green dashboard the
    // whole time.
    //
    // Rows-written is now load-bearing. A run that persists nothing is a
    // FAILURE regardless of whether anything threw, because "nothing threw"
    // and "the job did its job" are different claims.
    // ---------------------------------------------------------------
    const calendarRowsWritten = calendarInserted + calendarUpdated;
    const status: FetchStatus = resolveRunStatus({
      totalEvents,
      calendarRowsWritten,
      mappedCount,
      unmappedCount,
      mappedDeferredCount,
      errorCount: errors.length,
    });

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
        calendarInserted,
        calendarUpdated,
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
      calendarInserted,
      calendarUpdated,
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
        calendarInserted,
        calendarUpdated,
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
      calendarInserted,
      calendarUpdated,
      errors: [errorPayload],
      unmappedEvents,
      deferredEvents,
    };
  }
}

import { CalendarEvent } from '@prisma/client';
import { prisma } from '@core/db/prisma';

/**
 * Persistence for scheduled calendar-event occurrences (see the CalendarEvent
 * model). Kept deliberately thin: this table is a faithful record of what the
 * upstream feed sent, so there is no derivation or normalisation here beyond
 * the UTC conversion the ingest layer performs before calling in.
 */

export interface UpsertCalendarEventParams {
  source: string;
  country: string;
  title: string;
  /** UTC instant. The caller converts from the feed's offset-bearing string. */
  scheduledAt: Date;
  impact: string;
  /**
   * REFERENCE ONLY — Forex Factory's own consensus, stored for a future
   * cross-check against the manually-entered Trading Economics forecast.
   * No scoring path may read it.
   */
  forecastRaw: string | null;
  previousRaw: string | null;
  /** Null until the release publishes; filled in by a later same-week run. */
  actualRaw: string | null;
  indicatorId: string | null;
  indicatorCode: string | null;
  variant: string | null;
  /**
   * Companion-event designation from the mapping table (see the COMPANION
   * EVENTS doc in forex-factory-event-mapping.ts). Denormalised onto the row
   * at ingest time so the overdue resolver and calendar render can read it
   * without a join back to the mapping table. Always true for unmapped
   * events — the caller passes true when resolution is null.
   */
  isPrimary: boolean;
  fetchedVia: string | null;
}

export type CalendarUpsertAction = 'inserted' | 'updated';

export interface CalendarUpsertResult {
  action: CalendarUpsertAction;
  event: CalendarEvent;
}

/**
 * Near-duplicate collapse window — mirrors collapseNearDuplicates in
 * forex-factory-indicator.service.ts (the in-fetch collapse). Two feed rows
 * for the SAME (source, country, title) whose scheduledAt instants fall
 * within this window of each other are the same occurrence, not a
 * reschedule. 5 minutes is wide enough to absorb feed jitter (the observed
 * case: a placeholder row and the real row 60 seconds apart) and narrow
 * enough that a genuine reschedule — which moves an event by hours or days —
 * is never caught by it.
 */
const NEAR_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

/**
 * True when a row is more "real" than a placeholder — carries at least one
 * of forecastRaw/previousRaw. Mirrors the same test in
 * collapseNearDuplicates; kept independent (not exported/shared) because the
 * two call sites compare different shapes (raw feed events here vs already
 * -parsed upsert params there) and duplicating a three-line predicate reads
 * more clearly than threading a shared helper across a service/repository
 * boundary for it.
 */
function hasPopulatedFields(row: { forecastRaw: string | null; previousRaw: string | null }): boolean {
  return row.forecastRaw !== null || row.previousRaw !== null;
}

export const calendarEventsRepository = {
  /**
   * Insert-or-update on the natural key (source, country, title, scheduledAt)
   * — WIDENED to a ±5-minute window on scheduledAt for the existing-row
   * lookup only (see NEAR_DUPLICATE_WINDOW_MS doc above).
   *
   * The feed is pulled twice daily and re-sends the whole week every time, so
   * exact-key idempotency alone must hold — without it each event would
   * accumulate ~14 rows per week. That still works exactly as before for the
   * overwhelming majority of events (their scheduledAt never changes between
   * fetches, so the widened lookup finds the same exact-match row it always
   * did).
   *
   * The widening exists for one narrow case: Forex Factory itself has been
   * observed emitting the SAME release as two feed rows in one fetch,
   * identical title, ~60 seconds apart (a placeholder followed by the real
   * row). collapseNearDuplicates in the ingest service collapses that within
   * a single fetch; this lookup handles the case collapseNearDuplicates
   * cannot see — a placeholder landing in one fetch and the real row arriving
   * in the NEXT fetch, when they are two separate upsert() calls made hours
   * apart. Without this, the natural key's own assumption ("a distinct
   * scheduledAt is a distinct occurrence") lets the second fetch insert a
   * second row instead of updating the first.
   *
   * MERGE RULE when an existing row is found within the window but at a
   * different exact scheduledAt: whichever row carries forecastRaw and/or
   * previousRaw is authoritative for ALL fields, including scheduledAt — a
   * placeholder's timestamp carries no more authority than its empty fields
   * do. If neither row has them, or both do, the EXISTING row's fields
   * (including scheduledAt) are left unchanged; there is no basis to prefer
   * one over the other, and unnecessary churn on scheduledAt is worse than
   * leaving it as first recorded.
   *
   * A genuine reschedule — the same title moved by hours or days — falls
   * OUTSIDE the 5-minute window and is therefore never matched here; it
   * inserts as a new row, which is correct (see the CalendarEvent model
   * comment: "A rescheduled event therefore appears as a new row; that is
   * intended").
   */
  async upsert(params: UpsertCalendarEventParams): Promise<CalendarUpsertResult> {
    const windowStart = new Date(params.scheduledAt.getTime() - NEAR_DUPLICATE_WINDOW_MS);
    const windowEnd = new Date(params.scheduledAt.getTime() + NEAR_DUPLICATE_WINDOW_MS);

    const existing = await prisma.calendarEvent.findFirst({
      where: {
        source: params.source,
        country: params.country,
        title: params.title,
        scheduledAt: { gte: windowStart, lte: windowEnd },
      },
      // Deterministic pick if more than one stored row somehow falls in the
      // window (e.g. pre-fix historical duplicates) — closest instant first.
      orderBy: { scheduledAt: 'asc' },
    });

    const mutable = {
      impact: params.impact,
      forecastRaw: params.forecastRaw,
      previousRaw: params.previousRaw,
      actualRaw: params.actualRaw,
      indicatorId: params.indicatorId,
      indicatorCode: params.indicatorCode,
      variant: params.variant,
      isPrimary: params.isPrimary,
      fetchedVia: params.fetchedVia,
    };

    if (existing) {
      const isExactKeyMatch = existing.scheduledAt.getTime() === params.scheduledAt.getTime();

      // Exact-key match — the overwhelmingly common case (same fetch cadence
      // re-sending the same occurrence). Unconditional full refresh, exactly
      // the pre-existing contract: "everything else is refreshed," which is
      // what lets an `actual` that publishes mid-week land on the row
      // written when it was still forecast-only. The populated-fields merge
      // gate below is deliberately NOT applied here — it exists only to
      // arbitrate between two DIFFERENT occurrences the window judged to be
      // the same release, not to second-guess a routine refresh of the one
      // occurrence the key already identifies.
      if (isExactKeyMatch) {
        const event = await prisma.calendarEvent.update({
          where: { id: existing.id },
          data: mutable,
        });
        return { action: 'updated', event };
      }

      // Near-duplicate within the window but NOT an exact key match: two
      // rows the ingest layer believes are the same real-world occurrence
      // (e.g. a placeholder from an earlier fetch, the real row now). See
      // the MERGE RULE in this method's doc comment above.
      const incomingWins = hasPopulatedFields(params) && !hasPopulatedFields(existing);
      const updatePayload = incomingWins
        ? { ...mutable, scheduledAt: params.scheduledAt }
        : { ...mutable, scheduledAt: existing.scheduledAt, forecastRaw: existing.forecastRaw, previousRaw: existing.previousRaw };

      const event = await prisma.calendarEvent.update({
        where: { id: existing.id },
        data: updatePayload,
      });
      return { action: 'updated', event };
    }

    const event = await prisma.calendarEvent.create({
      data: {
        source: params.source,
        country: params.country,
        title: params.title,
        scheduledAt: params.scheduledAt,
        ...mutable,
      },
    });
    return { action: 'inserted', event };
  },

  /**
   * Events in a UTC instant window, mapped ones first-class. `indicatorCodes`
   * restricts to the calendar's in-universe set; omitting it returns
   * everything including unmapped rows.
   */
  async findInWindow(params: {
    fromUtc: Date;
    toUtc: Date;
    indicatorCodes?: string[];
  }): Promise<CalendarEvent[]> {
    return prisma.calendarEvent.findMany({
      where: {
        scheduledAt: { gte: params.fromUtc, lt: params.toUtc },
        ...(params.indicatorCodes
          ? { indicatorCode: { in: params.indicatorCodes } }
          : {}),
      },
      orderBy: [{ scheduledAt: 'asc' }, { country: 'asc' }, { title: 'asc' }],
    });
  },

  /**
   * The admin unmapped queue: occurrences whose (country, title) matched no
   * mapping entry. An upstream rename surfaces here rather than as a silent
   * gap, which is the whole point of storing unmapped events at all.
   */
  async findUnmapped(params: { since?: Date; limit?: number } = {}): Promise<CalendarEvent[]> {
    return prisma.calendarEvent.findMany({
      where: {
        indicatorId: null,
        ...(params.since ? { scheduledAt: { gte: params.since } } : {}),
      },
      orderBy: [{ scheduledAt: 'desc' }],
      take: params.limit ?? 500,
    });
  },

  /**
   * The next scheduled occurrence (any variant) for each of `indicatorCodes`,
   * later than `afterUtc`. One row per code that has a future event; a code
   * with none stored is simply absent from the returned map — the caller
   * reads that as "unknown", never as an error.
   *
   * A single query rather than one per indicator: the heatmap resolves this
   * for the whole registry (~65 codes) per request, and an ORDER BY +
   * DISTINCT ON per-code pick here is one round trip instead of N.
   *
   * Batched with the same shape as the route's existing dpByIndicatorId /
   * indicatorScoreMap maps — findMany + reduce, not a raw query — because
   * "first row when grouped by code, ordered by time" is exactly what a
   * client-side reduce over an already-sorted result gives for free, and
   * calendar_events per indicator is small (a handful of rows a week).
   */
  async findNextByIndicatorCodes(
    indicatorCodes: string[],
    afterUtc: Date,
  ): Promise<Map<string, CalendarEvent>> {
    if (indicatorCodes.length === 0) return new Map();

    const rows = await prisma.calendarEvent.findMany({
      where: {
        indicatorCode: { in: indicatorCodes },
        scheduledAt: { gt: afterUtc },
      },
      orderBy: { scheduledAt: 'asc' },
    });

    const next = new Map<string, CalendarEvent>();
    for (const row of rows) {
      // Rows arrive time-ascending; the first one seen per code is its
      // earliest future occurrence, so a later row for the same code is
      // never allowed to overwrite it.
      if (!next.has(row.indicatorCode as string)) {
        next.set(row.indicatorCode as string, row);
      }
    }
    return next;
  },
};

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
  fetchedVia: string | null;
}

export type CalendarUpsertAction = 'inserted' | 'updated';

export interface CalendarUpsertResult {
  action: CalendarUpsertAction;
  event: CalendarEvent;
}

export const calendarEventsRepository = {
  /**
   * Insert-or-update on the natural key (source, country, title, scheduledAt).
   * The feed is pulled twice daily and re-sends the whole week every time, so
   * this must be idempotent — without it each event would accumulate ~14 rows
   * per week.
   *
   * Identity fields are never part of the update payload: they ARE the key.
   * Everything else is refreshed, which is what lets an `actual` that
   * publishes mid-week land on the row that was written when it was still a
   * forecast-only future event.
   */
  async upsert(params: UpsertCalendarEventParams): Promise<CalendarUpsertResult> {
    const existing = await prisma.calendarEvent.findUnique({
      where: {
        calendar_event_natural_key: {
          source: params.source,
          country: params.country,
          title: params.title,
          scheduledAt: params.scheduledAt,
        },
      },
      select: { id: true },
    });

    const mutable = {
      impact: params.impact,
      forecastRaw: params.forecastRaw,
      previousRaw: params.previousRaw,
      actualRaw: params.actualRaw,
      indicatorId: params.indicatorId,
      indicatorCode: params.indicatorCode,
      variant: params.variant,
      fetchedVia: params.fetchedVia,
    };

    const event = await prisma.calendarEvent.upsert({
      where: {
        calendar_event_natural_key: {
          source: params.source,
          country: params.country,
          title: params.title,
          scheduledAt: params.scheduledAt,
        },
      },
      update: mutable,
      create: {
        source: params.source,
        country: params.country,
        title: params.title,
        scheduledAt: params.scheduledAt,
        ...mutable,
      },
    });

    return { action: existing ? 'updated' : 'inserted', event };
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

import { CalendarEventDeferral } from '@prisma/client';
import { prisma } from '@core/db/prisma';

/**
 * Persistence for B2 deferral (snooze) rows. See the CalendarEventDeferral
 * model comment in schema.prisma for the two-shape design (one-off vs
 * standing). This repository does no staleness logic of its own — that
 * lives in overdue-resolver.ts, which reads deferrals only to decide
 * whether an already-overdue event should be SURFACED, never to decide
 * whether it IS overdue.
 */

export interface CreateDeferralParams {
  indicatorId: string;
  indicatorCode: string;
  variant: string | null;
  /** Non-null event id for a one-off deferral, null for a standing one. */
  calendarEventId: string | null;
  /** Null = deferred indefinitely. */
  deferUntil: Date | null;
  reason: string | null;
  createdBy: string | null;
}

export const calendarEventDeferralsRepository = {
  /**
   * Create a deferral. Standing deferrals (calendarEventId: null) upsert on
   * the partial-unique (indicatorId, variant) key — deferring an
   * already-standing-deferred indicator again REPLACES the prior deferral
   * (new date/reason) rather than erroring or stacking a second row, since
   * only the newest standing deferral is ever meaningful to read.
   *
   * One-off deferrals never collide (an event can only be deferred once at
   * a time in the UI's own flow, but even a duplicate row would just mean
   * two equally-valid "yes, deferred" rows — findActiveForEvent takes the
   * newest, so this is harmless even if it happened).
   */
  async create(params: CreateDeferralParams): Promise<CalendarEventDeferral> {
    if (params.calendarEventId === null) {
      // Standing deferral: replace-in-place under the partial unique index
      // (calendar_event_deferrals_standing_unique, WHERE calendar_event_id
      // IS NULL — see the migration). Prisma's schema DSL has no partial-
      // unique syntax, so `upsert` can't target it directly; a transaction
      // (find-then-write, serialised) is used instead of two unguarded
      // statements to avoid a race between two concurrent standing-deferral
      // requests for the same (indicatorId, variant) each deciding to CREATE.
      return prisma.$transaction(async (tx) => {
        const existing = await tx.calendarEventDeferral.findFirst({
          where: { indicatorId: params.indicatorId, variant: params.variant, calendarEventId: null },
          select: { id: true },
        });
        if (existing) {
          return tx.calendarEventDeferral.update({
            where: { id: existing.id },
            data: {
              deferUntil: params.deferUntil,
              reason: params.reason,
              createdBy: params.createdBy,
            },
          });
        }
        return tx.calendarEventDeferral.create({
          data: {
            indicatorId: params.indicatorId,
            indicatorCode: params.indicatorCode,
            variant: params.variant,
            calendarEventId: null,
            deferUntil: params.deferUntil,
            reason: params.reason,
            createdBy: params.createdBy,
          },
        });
      });
    }

    return prisma.calendarEventDeferral.create({
      data: {
        indicatorId: params.indicatorId,
        indicatorCode: params.indicatorCode,
        variant: params.variant,
        calendarEventId: params.calendarEventId,
        deferUntil: params.deferUntil,
        reason: params.reason,
        createdBy: params.createdBy,
      },
    });
  },

  /**
   * Every deferral relevant to a set of (indicatorId, variant) pairs — both
   * one-off rows tied to a specific event and standing rows for the pair.
   * Callers combine this with a candidate event list to decide, per event,
   * whether a one-off row targets it directly or a standing row for its
   * (indicatorId, variant) applies.
   */
  async findForIndicatorVariantPairs(
    pairs: Array<{ indicatorId: string; variant: string | null }>,
  ): Promise<CalendarEventDeferral[]> {
    if (pairs.length === 0) return [];
    const indicatorIds = [...new Set(pairs.map((p) => p.indicatorId))];
    return prisma.calendarEventDeferral.findMany({
      where: { indicatorId: { in: indicatorIds } },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** All deferrals, for the deferred-list panel (recessed, always visible). */
  async findAll(): Promise<CalendarEventDeferral[]> {
    return prisma.calendarEventDeferral.findMany({
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Delete every deferral matching an entered data point exactly —
   * (indicatorId, variant). Called unconditionally on every manual data
   * entry, regardless of whether the entry was for an overdue event at all:
   * deferral is a snooze, never a suppression, so entering data always
   * clears it. Deletes BOTH shapes: the one-off row for this specific
   * occurrence (if any) and the standing row for the pair (if any) — a
   * standing deferral exists to snooze THIS release's cadence, and once a
   * value has actually been entered, the thing it was snoozing has resolved.
   */
  async clearForEntry(indicatorId: string, variant: string | null): Promise<number> {
    const result = await prisma.calendarEventDeferral.deleteMany({
      where: { indicatorId, variant },
    });
    return result.count;
  },

  async delete(id: string): Promise<void> {
    await prisma.calendarEventDeferral.delete({ where: { id } });
  },
};

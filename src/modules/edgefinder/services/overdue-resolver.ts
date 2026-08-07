import { CalendarEvent, CalendarEventDeferral } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { calendarEventDeferralsRepository } from '@core/repositories/calendar-event-deferrals.repository';

/**
 * THE single existence-join implementation for "has this scheduled release
 * been entered." Every consuming surface (asset scorecard, FX pair
 * scorecard, heatmap, admin data page, the top-bar badge's overdue AND
 * due-today buckets) reads this; none reimplements it. This codebase has
 * previously carried five independent win-rate implementations and three
 * equity-curve implementations — that history is why this file exists as
 * one place rather than N call sites each rolling their own version.
 *
 * OVERDUE is a specific, narrow fact, deliberately distinct from two other
 * staleness-adjacent mechanisms that remain running elsewhere and answer
 * different questions:
 *   - AGING (oracle-mappers.ts isAging) — is the value on file old in
 *     absolute terms (flat 60-day tolerance on observationDate).
 *   - DataHealth severity (data-health.ts) — is the value old relative to
 *     THIS indicator's own release cadence (frequency-scaled bands).
 * OVERDUE answers a third, narrower question: did a SPECIFIC SCHEDULED
 * RELEASE pass with nothing entered for it. All three stay running; none is
 * a fallback for another.
 *
 * Definition: a calendar_events row is overdue when
 *   scheduledAt < now - 24h
 *   AND no DataPoint exists for (indicatorId, variant, observationDate)
 *       where observationDate is EITHER scheduledAt truncated to a UTC
 *       calendar date OR scheduledAt truncated to an IST calendar date —
 *       see "the timezone boundary" below for why both are accepted.
 *
 * PER-EVENT, NOT PER-INDICATOR. Enter Flash PMI, skip Final: Final still
 * flags. Checking "does this indicator have ANY recent data" would see the
 * Flash row and go quiet — exactly the miss variants exist to catch. This is
 * why the resolver walks calendar_events (occurrences), not indicators.
 *
 * INDICATORS WITH NO CALENDAR EVENT ARE NEVER OVERDUE. There is nothing to
 * be overdue against. This covers every NIFTY indicator (zero calendar
 * events, always — NIFTY has no Forex Factory ingestion path) and the
 * indicators mapped but not yet observed by the feed this week. Absence of a
 * schedule is not evidence of a miss; the resolver never enumerates "all
 * indicators" and asks whether each has an event — it walks
 * calendar_events, so a code with no row there simply produces no result,
 * with no special-casing required for NIFTY or anything else.
 *
 * THE TIMEZONE BOUNDARY (widened match, not a rewrite of storage).
 * scheduledAt is a UTC instant; ingestion truncates it to a UTC calendar
 * date for DataPoint.observationDate (parseForexFactoryDate in
 * forex-factory-indicator.service.ts). But a trader entering data manually
 * types the date they SAW, in their own timezone — this app's default
 * display zone is IST. For an Asia-session event late in the UTC day (e.g.
 * 23:30 UTC), UTC and IST land on different calendar dates: JP_HSHLD_SPEND
 * at 2026-08-06T23:30:00Z is 2026-08-06 in UTC but 2026-08-07 in IST, and a
 * trader who entered "the 7th" (correctly, by what their screen showed) was
 * previously invisible to a resolver that only ever tried "the 6th" — a
 * false overdue waiting to fire the moment the 24h grace window passed.
 *
 * The fix widens the JOIN, not the STORAGE: a DataPoint on EITHER the
 * UTC-truncated date OR the IST-truncated date satisfies the event. No
 * observationDate is rewritten, no new column, no cutoff date, no event
 * excluded — this only changes which dates count as "yes, satisfied" when
 * deciding whether an already-scheduled event has a matching entry.
 */

const OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000;
/** IST is UTC+5:30, no DST — a fixed offset, safe to hardcode. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Truncate a UTC instant to a UTC calendar date — mirrors parseForexFactoryDate. */
function toUtcObservationDate(scheduledAt: Date): Date {
  return new Date(
    Date.UTC(scheduledAt.getUTCFullYear(), scheduledAt.getUTCMonth(), scheduledAt.getUTCDate()),
  );
}

/**
 * Truncate a UTC instant to the calendar date it falls on in IST. Computed
 * by shifting the instant forward by the fixed IST offset and reading its
 * UTC calendar fields — the shifted instant's "UTC date" is IST's date,
 * which is the standard trick for a fixed (non-DST) offset zone and avoids
 * pulling in Intl/timezone-name machinery for a single fixed shift.
 */
function toIstObservationDate(scheduledAt: Date): Date {
  const shifted = new Date(scheduledAt.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function entryKey(indicatorId: string, variant: string | null, observationDate: Date): string {
  return `${indicatorId}|${variant ?? ''}|${dateKey(observationDate)}`;
}

function pairKey(indicatorId: string, variant: string | null): string {
  return `${indicatorId}|${variant ?? ''}`;
}

export interface CandidateEvent {
  event: CalendarEvent;
  /** The UTC-truncated date — used as the canonical "which release is this" date everywhere a single date is reported (panels, DTOs). */
  observationDate: Date;
}

/**
 * THE shared existence join. Given a set of calendar_events rows, returns
 * the subset with NO matching DataPoint — i.e. still unentered. Both
 * findAllOverdue (>24h past) and findDueToday (within the grace window) call
 * this with their own candidate set; neither reimplements the match logic.
 *
 * Two queries regardless of candidate count, not N+1: one for the candidate
 * rows (caller-provided), one for every DataPoint that could possibly
 * satisfy any of them, then an in-memory set difference against BOTH the
 * UTC-dated and IST-dated key for each candidate.
 */
async function filterUnentered(candidates: CalendarEvent[]): Promise<CandidateEvent[]> {
  if (candidates.length === 0) return [];

  const indicatorIds = [...new Set(candidates.map((c) => c.indicatorId as string))];

  // The range must cover both truncations' earliest possible date — IST can
  // only ever be LATER than UTC for the same instant (a positive offset), so
  // the UTC-truncated minimum is always the correct lower bound for both.
  const earliestDate = candidates.reduce<Date>(
    (min, c) => (toUtcObservationDate(c.scheduledAt) < min ? toUtcObservationDate(c.scheduledAt) : min),
    toUtcObservationDate(candidates[0].scheduledAt),
  );

  // Every current-or-not DataPoint in range — deliberately not isCurrent-only.
  // A revised-away row still proves "something was entered for this release,"
  // which is exactly what this join needs to know; isCurrent answers a
  // scoring question (which vintage wins), not an entry-existence question.
  const dataPoints = await prisma.dataPoint.findMany({
    where: {
      indicatorId: { in: indicatorIds },
      observationDate: { gte: earliestDate },
    },
    select: { indicatorId: true, variant: true, observationDate: true },
  });

  const entered = new Set(
    dataPoints.map((dp) => entryKey(dp.indicatorId, dp.variant, dp.observationDate)),
  );

  const unentered: CandidateEvent[] = [];
  for (const event of candidates) {
    const utcDate = toUtcObservationDate(event.scheduledAt);
    const istDate = toIstObservationDate(event.scheduledAt);
    const utcKey = entryKey(event.indicatorId as string, event.variant, utcDate);
    // Same calendar date in both zones (the common case) — skip the
    // redundant second lookup rather than building an identical key twice.
    const satisfiedByUtc = entered.has(utcKey);
    const satisfiedByIst =
      dateKey(utcDate) === dateKey(istDate)
        ? false
        : entered.has(entryKey(event.indicatorId as string, event.variant, istDate));

    if (!satisfiedByUtc && !satisfiedByIst) {
      // Canonical reported date stays the UTC truncation — this is a display
      // choice, not a storage change; the widened match only affects whether
      // the event counts as satisfied, never which date gets reported for it.
      unentered.push({ event, observationDate: utcDate });
    }
  }
  return unentered;
}

export type OverdueEvent = CandidateEvent;

/**
 * Every overdue occurrence across the whole registry, as of `now`
 * (scheduledAt < now - 24h, no matching DataPoint on either the UTC or IST
 * truncated date).
 */
export async function findAllOverdue(now: Date = new Date()): Promise<OverdueEvent[]> {
  const cutoff = new Date(now.getTime() - OVERDUE_GRACE_MS);

  const candidates = await prisma.calendarEvent.findMany({
    where: {
      indicatorId: { not: null },
      scheduledAt: { lt: cutoff },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  return filterUnentered(candidates);
}

/**
 * Events scheduled today that have NOT yet crossed the 24h overdue
 * threshold, with no matching DataPoint on either truncated date — Fix 1:
 * previously this list had no DataPoint check at all, so it could never
 * clear on entry. It now runs through the exact same filterUnentered join
 * findAllOverdue uses; the only difference between "due today" and "overdue"
 * is which side of the 24h cutoff the event falls on, decided by the
 * caller-provided candidate query below, never by a second matching
 * implementation.
 *
 * "Due today" is advance visibility ("here's what's coming due"), not a
 * staleness signal — an event scheduled 3 hours ago with no data yet is
 * completely normal (releases don't get entered the instant they print), so
 * it must never count toward the badge (see buildOverduePanel.badgeCount).
 */
export async function findDueToday(now: Date = new Date()): Promise<OverdueEvent[]> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const overdueCutoff = new Date(now.getTime() - OVERDUE_GRACE_MS);

  const candidates = await prisma.calendarEvent.findMany({
    where: {
      indicatorId: { not: null },
      scheduledAt: { gte: dayStart, lt: dayEnd, gt: overdueCutoff },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  return filterUnentered(candidates);
}

/**
 * Overdue occurrences for a specific set of indicator codes — the shape
 * every scorecard/heatmap row needs ("is THIS indicator overdue"), built on
 * top of findAllOverdue rather than a separate query, so there is exactly
 * one place the overdue definition lives.
 */
export async function findOverdueByIndicatorCodes(
  codes: string[],
  now: Date = new Date(),
): Promise<Map<string, OverdueEvent[]>> {
  if (codes.length === 0) return new Map();
  const codeSet = new Set(codes);
  const all = await findAllOverdue(now);

  const byCode = new Map<string, OverdueEvent[]>();
  for (const o of all) {
    const code = o.event.indicatorCode;
    if (!code || !codeSet.has(code)) continue;
    const list = byCode.get(code);
    if (list) list.push(o);
    else byCode.set(code, [o]);
  }
  return byCode;
}

// ============================================================================
// B2 — deferral resolution
// ============================================================================

/** The three states B2 asks for. */
export type ReleaseState = 'overdue' | 'deferred_to_date' | 'deferred_indefinitely';

export interface ResolvedRelease {
  event: CalendarEvent;
  observationDate: Date;
  state: ReleaseState;
  /** The deferral row responsible for a deferred_* state; null when overdue. */
  deferral: CalendarEventDeferral | null;
}

/**
 * True calendar-date comparison (not instant comparison) for deferUntil,
 * since deferUntil is stored as a bare @db.Date with no time component —
 * "defer until March 14" means the event returns to overdue the moment
 * March 15 begins UTC, not 24 hours after the deferral was created.
 */
function deferralHasExpired(deferUntil: Date, now: Date): boolean {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return deferUntil.getTime() < today.getTime();
}

/**
 * Resolve every overdue occurrence to its final state, applying deferral
 * rows. This is the ONE place overdue-ness and deferral combine — every
 * consuming surface (resolver output) sees the same three-state result.
 *
 * Precedence when both a one-off row for this exact event AND a standing
 * row for its (indicatorId, variant) exist: the one-off row wins, because it
 * is the more specific, more recently deliberate action for THIS occurrence
 * — a standing "always defer AU PPI" plus someone explicitly re-deferring
 * this month's print to a shorter date should honour the shorter date.
 */
export async function resolveOverdue(now: Date = new Date()): Promise<ResolvedRelease[]> {
  const overdue = await findAllOverdue(now);
  if (overdue.length === 0) return [];

  const pairs = overdue.map((o) => ({
    indicatorId: o.event.indicatorId as string,
    variant: o.event.variant,
  }));
  const deferrals = await calendarEventDeferralsRepository.findForIndicatorVariantPairs(pairs);

  // Newest first (repository orders createdAt desc), so the first match per
  // key found while building these maps is already the newest.
  const oneOffByEventId = new Map<string, CalendarEventDeferral>();
  const standingByPair = new Map<string, CalendarEventDeferral>();
  for (const d of deferrals) {
    if (d.calendarEventId) {
      if (!oneOffByEventId.has(d.calendarEventId)) oneOffByEventId.set(d.calendarEventId, d);
    } else {
      const key = pairKey(d.indicatorId, d.variant);
      if (!standingByPair.has(key)) standingByPair.set(key, d);
    }
  }

  const resolved: ResolvedRelease[] = [];
  for (const o of overdue) {
    const oneOff = oneOffByEventId.get(o.event.id);
    const standing = standingByPair.get(pairKey(o.event.indicatorId as string, o.event.variant));
    const active = oneOff ?? standing ?? null;

    if (!active || (active.deferUntil && deferralHasExpired(active.deferUntil, now))) {
      resolved.push({ event: o.event, observationDate: o.observationDate, state: 'overdue', deferral: null });
      continue;
    }

    resolved.push({
      event: o.event,
      observationDate: o.observationDate,
      state: active.deferUntil ? 'deferred_to_date' : 'deferred_indefinitely',
      deferral: active,
    });
  }
  return resolved;
}

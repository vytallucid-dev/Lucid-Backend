import { prisma } from '@core/db/prisma';
import { resolveOverdue, ResolvedRelease, findDueToday as resolveDueToday, OverdueEvent } from './overdue-resolver';

/**
 * The B3 badge/panel read side: takes resolveOverdue's flat list and shapes
 * it into what the top-bar panel needs — due-today first, then overdue, then
 * deferred recessed at the bottom. The badge COUNT is overdue only (not
 * aging, not DataHealth, not deferred, not due-today) — see the count
 * function below for why due-today is excluded too.
 */

export interface OverduePanelEntry {
  id: string; // calendar_events row id — used to CREATE a one-off deferral
  // The CalendarEventDeferral row id currently silencing this entry, or null
  // when state is 'overdue' (nothing is silencing it). Required to UNDEFER:
  // the deferral responsible for a deferred_* entry may be either a one-off
  // row (calendarEventId === this event's id) or a STANDING row for the
  // indicator+variant — `id` above (the event id) is never a valid target
  // for delete, only `deferralId` is.
  deferralId: string | null;
  indicatorCode: string;
  indicatorName: string;
  variant: string | null;
  scheduledAt: string; // ISO UTC instant
  observationDate: string; // YYYY-MM-DD, the DataPoint date this event resolves to
  country: string;
  title: string;
  state: 'overdue' | 'deferred_to_date' | 'deferred_indefinitely';
  deferUntil: string | null; // YYYY-MM-DD, only for deferred_to_date
  reason: string | null;
}

export interface OverduePanel {
  /** Overdue events whose scheduledAt falls within the last 24h — the grace
   *  window itself, i.e. "would be overdue in the next moment but isn't yet
   *  quite 24h past." Surfaced first as advance warning, but NOT counted in
   *  the badge (see badgeCount doc) since they are not yet actually overdue. */
  dueToday: OverduePanelEntry[];
  overdue: OverduePanelEntry[];
  deferred: OverduePanelEntry[];
  /** Overdue count only — see resolveBadgeCount. */
  badgeCount: number;
}

async function toEntry(r: ResolvedRelease, namesByCode: Map<string, string>): Promise<OverduePanelEntry> {
  const code = r.event.indicatorCode as string;
  return {
    id: r.event.id,
    deferralId: r.deferral?.id ?? null,
    indicatorCode: code,
    indicatorName: namesByCode.get(code) ?? code,
    variant: r.event.variant,
    scheduledAt: r.event.scheduledAt.toISOString(),
    observationDate: r.observationDate.toISOString().slice(0, 10),
    country: r.event.country,
    title: r.event.title,
    state: r.state,
    deferUntil: r.deferral?.deferUntil ? r.deferral.deferUntil.toISOString().slice(0, 10) : null,
    reason: r.deferral?.reason ?? null,
  };
}

/**
 * "Due today" — events scheduled today that have NOT yet crossed the 24h
 * overdue threshold AND have no matching DataPoint. This is advance
 * visibility ("here's what's coming due"), not a staleness signal — an
 * event scheduled 3 hours ago with no data yet is completely normal
 * (releases don't get entered the instant they print), so it must never
 * count toward the badge.
 *
 * Fix 1: this bucket previously had no DataPoint check at all — it selected
 * from calendar_events alone, so an entered event could never leave the
 * list. It now calls the SAME filterUnentered join findAllOverdue uses
 * (exported from overdue-resolver.ts as findDueToday there); the only thing
 * distinguishing "due today" from "overdue" is which candidate query feeds
 * that one shared join, never a second matching implementation.
 */
async function buildDueTodayEntries(now: Date): Promise<OverduePanelEntry[]> {
  const dueToday = await resolveDueToday(now);
  if (dueToday.length === 0) return [];

  const indicatorIds = [...new Set(dueToday.map((o) => o.event.indicatorId as string))];
  const indicators = await prisma.indicator.findMany({
    where: { id: { in: indicatorIds } },
    select: { code: true, name: true },
  });
  const namesByCode = new Map(indicators.map((i) => [i.code, i.name]));

  return dueToday.map((o: OverdueEvent) => ({
    id: o.event.id,
    deferralId: null, // never deferred — a due-today event isn't overdue yet, so there is nothing to defer
    indicatorCode: o.event.indicatorCode as string,
    indicatorName: namesByCode.get(o.event.indicatorCode as string) ?? (o.event.indicatorCode as string),
    variant: o.event.variant,
    scheduledAt: o.event.scheduledAt.toISOString(),
    observationDate: o.observationDate.toISOString().slice(0, 10),
    country: o.event.country,
    title: o.event.title,
    state: 'overdue', // not yet true, but there is no separate "pending" state — the panel bucket (dueToday vs overdue) carries the distinction, not this field
    deferUntil: null,
    reason: null,
  }));
}

export async function buildOverduePanel(now: Date = new Date()): Promise<OverduePanel> {
  const [resolved, dueToday] = await Promise.all([resolveOverdue(now), buildDueTodayEntries(now)]);

  const codes = [...new Set(resolved.map((r) => r.event.indicatorCode as string))];
  const indicators = codes.length
    ? await prisma.indicator.findMany({ where: { code: { in: codes } }, select: { code: true, name: true } })
    : [];
  const namesByCode = new Map(indicators.map((i) => [i.code, i.name]));

  const overdue: OverduePanelEntry[] = [];
  const deferred: OverduePanelEntry[] = [];
  for (const r of resolved) {
    const entry = await toEntry(r, namesByCode);
    if (r.state === 'overdue') overdue.push(entry);
    else deferred.push(entry);
  }

  return {
    dueToday,
    overdue,
    deferred,
    // B3: the badge counts OVERDUE ONLY. Not aging, not DataHealth, not
    // deferred (a deferred event is by definition snoozed out of the count
    // — that is the entire purpose of deferring it), not due-today (not yet
    // actually overdue). Counting deferred would make deferral pointless;
    // counting due-today would make the badge fire before a release has any
    // realistic chance of being entered.
    badgeCount: overdue.length,
  };
}

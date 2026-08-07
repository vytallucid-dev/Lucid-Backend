import { DataPoint } from '@prisma/client';
import { prisma } from '@core/db/prisma';

/**
 * B3: scoring resolves to the most recent RELEASE for an indicator,
 * regardless of variant. Flash and Final (etc.) can now share an
 * observationDate (see the migration extending DataPoint's unique
 * constraint to include variant), so the old `orderBy: { observationDate:
 * 'desc' }` no longer resolves to a unique row on its own — for a date with
 * both a current Flash row and a current Final row, plain observationDate
 * ordering picks between them arbitrarily (whichever Postgres happens to
 * return first).
 *
 * Resolution order: observationDate desc, then variant ordinal desc, then
 * vintageDate desc.
 *
 * Ordinal (not vintageDate) is the primary tiebreaker deliberately —
 * vintageDate is entry time, so entering Final before Flash would resolve to
 * the wrong row. Ordinal is a property of the release itself and is
 * independent of entry order. A variant absent from indicator_variants
 * (single-release indicators, and any DataPoint row with variant=null) is
 * treated as ordinal -1 — lower than every registered variant — so it never
 * wins a same-date tie against a registered release; for the overwhelming
 * majority of indicators (no variants registered at all) this is a no-op
 * since there is only ever one current row per observationDate there.
 *
 * vintageDate desc is the final tiebreaker — same as the old behaviour — for
 * same-variant same-date rows (shouldn't normally happen given isCurrent,
 * but recon found a real duplicate-isCurrent row on a NIFTY indicator, so
 * this resolver does not assume isCurrent uniqueness holds; it is fully
 * deterministic on its own).
 *
 * Flash and Final have no relationship to each other here — this resolver
 * only picks ONE row (the most recent release). Nothing computes a delta
 * between variants. Known and accepted consequence: when a Final lands after
 * a Flash for the same observationDate, this resolver switches from the
 * Flash row to the Final row and the score can move with no new surprise
 * (the Final's value differs from the Flash's). This is correct, not a bug —
 * do not "fix" it by trying to reconcile Flash and Final.
 */

let ordinalCache: Map<string, Map<string, number>> | null = null;

async function getOrdinalMap(indicatorId: string): Promise<Map<string, number>> {
  if (!ordinalCache) ordinalCache = new Map();
  const cached = ordinalCache.get(indicatorId);
  if (cached) return cached;

  const rows = await prisma.indicatorVariant.findMany({
    where: { indicatorId },
    select: { variant: true, ordinal: true },
  });
  const map = new Map(rows.map((r) => [r.variant, r.ordinal]));
  ordinalCache.set(indicatorId, map);
  return map;
}

/** Test-only: clear the ordinal cache between test cases. */
export function __resetOrdinalCacheForTests(): void {
  ordinalCache = null;
}

// Exported for direct testing of the tiebreak logic in isolation (pure
// functions, no DB access) — see tests/core/scoring/helpers/latest-release.test.ts.
export function ordinalOf(variant: string | null, ordinals: Map<string, number>): number {
  if (variant === null) return -1;
  return ordinals.get(variant) ?? -1;
}

export function pickLatestRelease(rows: DataPoint[], ordinals: Map<string, number>): DataPoint | null {
  if (rows.length === 0) return null;
  let best = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowDate = row.observationDate.getTime();
    const bestDate = best.observationDate.getTime();
    if (rowDate !== bestDate) {
      if (rowDate > bestDate) best = row;
      continue;
    }
    const rowOrdinal = ordinalOf(row.variant, ordinals);
    const bestOrdinal = ordinalOf(best.variant, ordinals);
    if (rowOrdinal !== bestOrdinal) {
      if (rowOrdinal > bestOrdinal) best = row;
      continue;
    }
    if (row.vintageDate.getTime() > best.vintageDate.getTime()) best = row;
  }
  return best;
}

/**
 * Single-row resolution: the most recent release for an indicator on or
 * before `asOfDate`. Replaces the old
 *   prisma.dataPoint.findFirst({ where: {...}, orderBy: { observationDate: 'desc' } })
 * pattern used by normal/inverted/rate-decision and the score-writer
 * fallback.
 */
export async function findLatestRelease(
  indicatorId: string,
  asOfDate: Date,
): Promise<DataPoint | null> {
  // Pull every current row on the latest observationDate that has any
  // current row, then resolve variant ties in application code. Fetching by
  // date rather than by row-count keeps this correct regardless of how many
  // variants exist for that date (0, 1, or N).
  const latestDateRow = await prisma.dataPoint.findFirst({
    where: { indicatorId, isCurrent: true, observationDate: { lte: asOfDate } },
    orderBy: { observationDate: 'desc' },
    select: { observationDate: true },
  });
  if (!latestDateRow) return null;

  const candidates = await prisma.dataPoint.findMany({
    where: { indicatorId, isCurrent: true, observationDate: latestDateRow.observationDate },
  });

  const ordinals = await getOrdinalMap(indicatorId);
  return pickLatestRelease(candidates, ordinals);
}

/**
 * Lookback-window resolution: up to `take` distinct observationDates on or
 * before `asOfDate`, each resolved to its most recent release, most recent
 * date first. Replaces the old
 *   prisma.dataPoint.findMany({ where: {...}, orderBy: { observationDate: 'desc' }, take })
 * pattern used by rolling/window handlers reachable from EdgeFinder
 * (us02y-sma). Fetches a superset of raw rows (bounded — see maxRawRows)
 * since a single observationDate can now yield more than one current row
 * (Flash + Final), then collapses to one row per date before truncating to
 * `take`.
 */
export async function findLatestReleasesWindow(
  indicatorId: string,
  asOfDate: Date,
  take: number,
): Promise<DataPoint[]> {
  if (take <= 0) return [];

  // Every indicator actually carrying variants today has at most 3 releases
  // per date (Advance/Second/Third). 4x headroom over `take` distinct dates
  // comfortably covers that with margin, without an unbounded fetch.
  const maxRawRows = take * 4;
  const rawRows = await prisma.dataPoint.findMany({
    where: { indicatorId, isCurrent: true, observationDate: { lte: asOfDate } },
    orderBy: [{ observationDate: 'desc' }, { vintageDate: 'desc' }],
    take: maxRawRows,
  });
  if (rawRows.length === 0) return [];

  const ordinals = await getOrdinalMap(indicatorId);

  const byDate = new Map<number, DataPoint[]>();
  for (const row of rawRows) {
    const key = row.observationDate.getTime();
    const bucket = byDate.get(key);
    if (bucket) bucket.push(row);
    else byDate.set(key, [row]);
  }

  const resolvedDates = [...byDate.keys()].sort((a, b) => b - a);
  const result: DataPoint[] = [];
  for (const dateKey of resolvedDates) {
    if (result.length >= take) break;
    const winner = pickLatestRelease(byDate.get(dateKey)!, ordinals);
    if (winner) result.push(winner);
  }

  // If the superset fetch didn't reach far enough back to fill `take`
  // distinct dates (possible in principle if a single date had more raw
  // rows than expected), fall back to a direct query for the remainder.
  // This only ever fires if maxRawRows undershoots — cheap safety net, not
  // the common path.
  if (result.length < take && rawRows.length === maxRawRows) {
    const oldestResolvedDate = result.length > 0 ? result[result.length - 1].observationDate : asOfDate;
    const more = await findLatestReleasesWindow(
      indicatorId,
      new Date(oldestResolvedDate.getTime() - 1),
      take - result.length,
    );
    result.push(...more);
  }

  return result;
}

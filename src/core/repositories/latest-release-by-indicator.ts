import { prisma } from '@core/db/prisma';

/**
 * Shared "one current row per indicator, most-recent-release wins" resolver
 * for display/read paths (admin indicator list, oracle scorecard/heatmap/
 * fx-scorecard, data-health staleness). Scoring has its own resolver
 * (src/core/scoring/helpers/latest-release.ts) with the same tiebreak logic
 * — kept separate because scoring resolves per-indicator-per-date (as of a
 * given observationDate) while these callers resolve per-indicator-latest
 * across a batch of indicator ids in one query. Duplicating the tiebreak
 * here rather than importing the scoring helper keeps scoring's module
 * boundary intact (nothing outside src/core/scoring depended on it before,
 * and scoring's helper is deliberately scoped to ScoringContext-shaped
 * callers).
 *
 * Same tiebreak as scoring: observationDate desc, then variant ordinal desc,
 * then vintageDate desc. A variant absent from indicator_variants (no
 * registered variants for that indicator, or variant=null) sorts as ordinal
 * -1 — this is a no-op for the overwhelming majority of indicators, which
 * have never had more than one current row per observationDate.
 */

export interface LatestReleaseRow {
  indicatorId: string;
  variant: string | null;
  observationDate: Date;
  vintageDate: Date;
}

function ordinalOf(variant: string | null, ordinals: Map<string, number>): number {
  if (variant === null) return -1;
  return ordinals.get(variant) ?? -1;
}

/**
 * Given rows for potentially many indicators (each row already isCurrent, no
 * date-range filter applied by this function), collapse to at most one row
 * per indicatorId — the most recent release. Rows do not need to be
 * pre-sorted; this does a full pass per indicator group.
 */
export async function collapseToLatestReleasePerIndicator<T extends LatestReleaseRow>(
  rows: T[],
): Promise<Map<string, T>> {
  if (rows.length === 0) return new Map();

  const indicatorIds = [...new Set(rows.map((r) => r.indicatorId))];
  const variantRows = await prisma.indicatorVariant.findMany({
    where: { indicatorId: { in: indicatorIds } },
    select: { indicatorId: true, variant: true, ordinal: true },
  });
  const ordinalsByIndicator = new Map<string, Map<string, number>>();
  for (const v of variantRows) {
    let m = ordinalsByIndicator.get(v.indicatorId);
    if (!m) {
      m = new Map();
      ordinalsByIndicator.set(v.indicatorId, m);
    }
    m.set(v.variant, v.ordinal);
  }
  const emptyOrdinals = new Map<string, number>();

  const best = new Map<string, T>();
  for (const row of rows) {
    const current = best.get(row.indicatorId);
    if (!current) {
      best.set(row.indicatorId, row);
      continue;
    }
    const ordinals = ordinalsByIndicator.get(row.indicatorId) ?? emptyOrdinals;
    const rowDate = row.observationDate.getTime();
    const curDate = current.observationDate.getTime();
    if (rowDate !== curDate) {
      if (rowDate > curDate) best.set(row.indicatorId, row);
      continue;
    }
    const rowOrdinal = ordinalOf(row.variant, ordinals);
    const curOrdinal = ordinalOf(current.variant, ordinals);
    if (rowOrdinal !== curOrdinal) {
      if (rowOrdinal > curOrdinal) best.set(row.indicatorId, row);
      continue;
    }
    if (row.vintageDate.getTime() > current.vintageDate.getTime()) {
      best.set(row.indicatorId, row);
    }
  }
  return best;
}

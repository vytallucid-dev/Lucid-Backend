import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';

/**
 * Look up the most recent `rate_level` recorded for an indicator before a given date.
 *
 * Used by rate-decision ingestion paths (ForexFactory cron + manual entry) to
 * compute bps_change vs the prior rate. Returns null when no prior data point
 * exists for this indicator (first-release case).
 */
export async function getPriorRateLevel(
  indicatorId: string,
  beforeDate: Date,
): Promise<number | null> {
  const prior = await prisma.dataPoint.findFirst({
    where: {
      indicatorId,
      isCurrent: true,
      observationDate: { lt: beforeDate },
    },
    orderBy: { observationDate: 'desc' },
    select: { sourceMetadata: true },
  });

  if (!prior || prior.sourceMetadata === null) return null;
  const meta = prior.sourceMetadata as Prisma.JsonObject;
  const rateLevel = meta.rate_level;
  if (typeof rateLevel === 'number' && Number.isFinite(rateLevel)) return rateLevel;
  if (typeof rateLevel === 'string') {
    const parsed = Number(rateLevel);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Change 2 (rate decision scores surprise) — Step 1. Converts an absolute
 * rate level (entered/published the same way `actual` is) into a bps-change
 * delta versus a prior level, using the IDENTICAL formula ingestion already
 * uses for `value`: `(level - priorLevel) * 100`. Reusing this one function
 * for both the actual bps-change and the expected bps-change is what keeps
 * DataPoint.value and DataPoint.forecastValue in the same unit — the thing
 * the recon flagged as the most likely way this silently breaks.
 *
 * Returns null when there is no level to convert, or no prior level to
 * diff against (first release) — there is no meaningful delta to store, and
 * a null forecastValue is exactly the "no expectation on file" signal the
 * rate-decision handler's insufficient_data path (Step 3) depends on.
 */
export function levelToBpsChange(level: number | null, priorLevel: number | null): number | null {
  if (level === null || priorLevel === null) return null;
  return (level - priorLevel) * 100;
}

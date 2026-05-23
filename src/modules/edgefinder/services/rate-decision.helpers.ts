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

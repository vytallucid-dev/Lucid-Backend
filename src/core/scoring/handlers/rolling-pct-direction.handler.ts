import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { ScoringContext, ScoringResult, Score } from '../types';
import { getSkipDates } from '../helpers/frozen-date-crosscheck';

interface Tier {
  min: number | null;
  max: number | null;
  score: Score;
}

function tierLookup(value: number, tiers: Tier[]): Score | null {
  for (const t of tiers) {
    const aboveMin = t.min === null || value >= t.min;
    const belowMax = t.max === null || value < t.max;
    if (aboveMin && belowMax) return t.score;
  }
  return null;
}

export async function rollingPctDirectionHandler(
  ctx: ScoringContext,
): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    lookback_trading_days: number;
    tiers: Tier[];
  };

  const needed = rule.lookback_trading_days + 1;

  const { skipDates, warnings } = await getSkipDates({
    indicatorCode: ctx.indicatorCode,
    indicatorId: ctx.indicatorId,
    observationDate: ctx.observationDate,
    lookbackRows: needed,
  });

  for (const warning of warnings) {
    logger.warn(warning, 'Suspected frozen feed breakage detected during rolling window scan');
  }

  const supersetTake = skipDates.size > 0 ? Math.max(needed + skipDates.size, needed * 3, 40) : needed;

  const superset = await prisma.dataPoint.findMany({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: ctx.observationDate },
    },
    orderBy: { observationDate: 'desc' },
    take: supersetTake,
  });

  const points = superset
    .filter((p) => !skipDates.has(p.observationDate.toISOString().slice(0, 10)))
    .slice(0, needed);

  if (points.length < needed) {
    return {
      kind: 'insufficient_data',
      reason: `Need ${needed} points for ${rule.lookback_trading_days}-day pct change; have ${points.length}`,
    };
  }

  const newest = Number(points[0].value);
  const oldest = Number(points[points.length - 1].value);
  if (oldest === 0) {
    return {
      kind: 'insufficient_data',
      reason: 'Oldest value is zero, cannot compute pct change',
    };
  }

  const pctChange = ((newest - oldest) / oldest) * 100;
  const score = tierLookup(pctChange, rule.tiers);
  if (score === null) {
    return { kind: 'insufficient_data', reason: `pct change ${pctChange} matched no tier` };
  }

  return {
    kind: 'scored',
    score,
    flags: [],
    metadata: {
      pctChange,
      newest,
      oldest,
      lookbackDays: rule.lookback_trading_days,
      newestObservationDate: points[0].observationDate.toISOString().slice(0, 10),
      oldestObservationDate: points[points.length - 1].observationDate.toISOString().slice(0, 10),
    },
  };
}

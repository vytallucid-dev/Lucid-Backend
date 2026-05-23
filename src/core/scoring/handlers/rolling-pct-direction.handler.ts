import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

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

  const points = await prisma.dataPoint.findMany({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: ctx.observationDate },
    },
    orderBy: { observationDate: 'desc' },
    take: rule.lookback_trading_days,
  });

  if (points.length < rule.lookback_trading_days) {
    return {
      kind: 'insufficient_data',
      reason: `Need ${rule.lookback_trading_days} points; have ${points.length}`,
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

import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

interface Tier {
  min: number | null;
  max: number | null;
  score: Score;
}

export async function rollingPctTieredHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    lookback_trading_days: number;
    tiers: Tier[];
  };

  const needed = rule.lookback_trading_days + 1;

  const points = await prisma.dataPoint.findMany({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: ctx.observationDate },
    },
    orderBy: { observationDate: 'desc' },
    take: needed,
  });

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

  let matched: Score | null = null;
  for (const tier of rule.tiers) {
    const aboveMin = tier.min === null || pctChange >= tier.min;
    const belowMax = tier.max === null || pctChange < tier.max;
    if (aboveMin && belowMax) {
      matched = tier.score;
      break;
    }
  }

  if (matched === null) {
    return { kind: 'insufficient_data', reason: `pct change ${pctChange} matched no tier` };
  }

  return {
    kind: 'scored',
    score: matched,
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

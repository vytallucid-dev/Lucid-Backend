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

export async function rollingTieredHandler(ctx: ScoringContext): Promise<ScoringResult> {
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
      reason: `Need ${rule.lookback_trading_days} data points; have ${points.length}`,
      details: { available: points.length, required: rule.lookback_trading_days },
    };
  }

  const values = points.map((p) => Number(p.value));
  const rollingAvg = values.reduce((a, b) => a + b, 0) / values.length;

  const score = tierLookup(rollingAvg, rule.tiers);
  if (score === null) {
    return {
      kind: 'insufficient_data',
      reason: `Rolling avg ${rollingAvg} did not match any tier`,
    };
  }

  return {
    kind: 'scored',
    score,
    flags: [],
    metadata: {
      rollingAvg,
      lookbackDays: rule.lookback_trading_days,
      latestObservationDate: points[0].observationDate.toISOString().slice(0, 10),
      oldestObservationDate: points[points.length - 1].observationDate.toISOString().slice(0, 10),
    },
  };
}

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

export async function rollingRatioExcludingHandler(
  ctx: ScoringContext,
): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    lookback_trading_days: number;
    tiers: Tier[];
    all_excluded_fallback: { score: Score; flag: string };
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
    };
  }

  const validDays = points.filter((p) => {
    const meta = (p.sourceMetadata ?? {}) as { fii_was_net_seller?: boolean };
    return meta.fii_was_net_seller === true;
  });

  if (validDays.length === 0) {
    return {
      kind: 'scored',
      score: rule.all_excluded_fallback.score,
      flags: [rule.all_excluded_fallback.flag],
      metadata: {
        excluded_all_5_days: true,
        totalDays: points.length,
      },
    };
  }

  const ratios = validDays.map((p) => Number(p.value));
  const rollingAvg = ratios.reduce((a, b) => a + b, 0) / ratios.length;

  const score = tierLookup(rollingAvg, rule.tiers);
  if (score === null) {
    return {
      kind: 'insufficient_data',
      reason: `Rolling ratio ${rollingAvg} did not match any tier`,
    };
  }

  const flags: string[] = [];
  // Negative rolling average means DII was, on net, ALSO selling on the FII-seller
  // days in the window — "both fleeing". Surface this distinct regime with a flag,
  // mirroring the all_excluded_fallback flag pattern above.
  if (rollingAvg < 0) {
    flags.push('DII_NET_SELLER_REGIME');
  }
  if (validDays.length < points.length) {
    flags.push(`PARTIAL_WINDOW_${validDays.length}of${points.length}`);
  }

  return {
    kind: 'scored',
    score,
    flags,
    metadata: {
      rollingAvg,
      validDaysCount: validDays.length,
      excludedDaysCount: points.length - validDays.length,
    },
  };
}

import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

interface CompositeTier {
  min: number | null;
  max: number | null;
  score: Score;
  exclusive_min?: boolean;
  exclusive_max?: boolean;
}

export async function manualRawCompositeHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    raw_range: { min: number; max: number };
    tiers: CompositeTier[];
  };

  const dp = await prisma.dataPoint.findFirst({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: ctx.observationDate },
    },
    orderBy: { observationDate: 'desc' },
  });

  if (!dp) {
    return {
      kind: 'insufficient_data',
      reason: 'No Ind 9 raw composite injection found',
    };
  }

  const raw = Number(dp.value);
  if (raw < rule.raw_range.min || raw > rule.raw_range.max) {
    return {
      kind: 'insufficient_data',
      reason: `Raw composite ${raw} out of valid range [${rule.raw_range.min}, ${rule.raw_range.max}]`,
    };
  }

  for (const tier of rule.tiers) {
    const aboveMin =
      tier.min === null
        ? true
        : tier.exclusive_min === true
          ? raw > tier.min
          : raw >= tier.min;
    const belowMax =
      tier.max === null
        ? true
        : tier.exclusive_max === true
          ? raw < tier.max
          : raw <= tier.max;
    if (aboveMin && belowMax) {
      return {
        kind: 'scored',
        score: tier.score,
        flags: [],
        metadata: {
          rawComposite: raw,
          tier: { min: tier.min, max: tier.max, score: tier.score },
          observationDate: dp.observationDate.toISOString().slice(0, 10),
          dataPointId: dp.id,
          source: 'manual_injection',
        },
      };
    }
  }

  return {
    kind: 'insufficient_data',
    reason: `Raw composite ${raw} did not match any tier`,
  };
}

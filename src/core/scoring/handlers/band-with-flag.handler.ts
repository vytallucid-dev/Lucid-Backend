import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

interface Band {
  min: number | null;
  max: number | null;
  score: Score;
  flag?: string;
}

export async function bandWithFlagHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    bands: Band[];
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
    return { kind: 'insufficient_data', reason: 'No data point found' };
  }

  const value = Number(dp.value);
  for (const band of rule.bands) {
    const aboveMin = band.min === null || value >= band.min;
    const belowMax = band.max === null || value < band.max;
    if (aboveMin && belowMax) {
      return {
        kind: 'scored',
        score: band.score,
        flags: band.flag ? [band.flag] : [],
        metadata: {
          value,
          band: { min: band.min, max: band.max },
          observationDate: dp.observationDate.toISOString().slice(0, 10),
        },
      };
    }
  }

  return { kind: 'insufficient_data', reason: `Value ${value} matched no band` };
}

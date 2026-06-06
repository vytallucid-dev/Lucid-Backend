import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

interface Band {
  min: number | null;
  max: number | null;
  score: Score;
  flag?: string;
}

export async function thresholdBandsHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    bands: Band[];
    historical_default?: Score;
    live_tracking_only?: boolean;
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
    if (rule.live_tracking_only && rule.historical_default !== undefined) {
      return {
        kind: 'scored',
        score: rule.historical_default,
        flags: ['HISTORICAL_DEFAULT_NO_DATA'],
        metadata: { reason: 'Ind 13 has no historical data pre-2020; default = 0' },
      };
    }
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

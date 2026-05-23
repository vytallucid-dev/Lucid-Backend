import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

export async function thresholdHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    reference: number;
    gt: Score;
    eq: Score;
    lt: Score;
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
      reason: 'No data point found on or before observation date',
      details: { indicatorCode: ctx.indicatorCode },
    };
  }

  const value = Number(dp.value);
  let score: Score;
  if (value > rule.reference) score = rule.gt;
  else if (value < rule.reference) score = rule.lt;
  else score = rule.eq;

  return {
    kind: 'scored',
    score,
    flags: [],
    metadata: {
      value,
      reference: rule.reference,
      observationDate: dp.observationDate.toISOString().slice(0, 10),
      dataPointId: dp.id,
    },
  };
}

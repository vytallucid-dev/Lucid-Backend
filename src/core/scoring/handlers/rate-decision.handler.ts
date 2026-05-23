import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

export async function rateDecisionHandler(ctx: ScoringContext): Promise<ScoringResult> {
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
      reason: 'No rate decision on file',
      details: { indicatorCode: ctx.indicatorCode },
    };
  }

  const bps = Number(dp.value);
  let score: Score;
  let decision: 'HIKE' | 'CUT' | 'HOLD';
  if (bps > 0) {
    score = 1;
    decision = 'HIKE';
  } else if (bps < 0) {
    score = -1;
    decision = 'CUT';
  } else {
    score = 0;
    decision = 'HOLD';
  }

  return {
    kind: 'scored',
    score,
    flags: [],
    metadata: {
      bps_change: bps,
      decision,
      decision_date: dp.observationDate.toISOString().slice(0, 10),
      dataPointId: dp.id,
    },
  };
}

import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

export async function cycleRegimeHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    states: Record<string, Score>;
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
      reason: 'No RBI MPC decision found on or before observation date',
    };
  }

  const meta = (dp.sourceMetadata ?? {}) as Record<string, unknown>;
  const explicitState = (meta as { state?: string }).state;

  let state: string;
  if (explicitState && typeof explicitState === 'string' && explicitState in rule.states) {
    state = explicitState;
  } else {
    return {
      kind: 'insufficient_data',
      reason: 'RBI data_point missing cycle state in sourceMetadata',
      details: {
        dataPointId: dp.id,
        suggestion:
          'Re-enter with sourceMetadata.state = one of: cutting, paused_after_hikes, hold_neutral, hiking, hawkish_hold',
      },
    };
  }

  const score = rule.states[state];
  return {
    kind: 'scored',
    score,
    flags: state === 'paused_after_hikes' ? ['P15-7_SATURATION'] : [],
    metadata: {
      state,
      rateValue: Number(dp.value),
      observationDate: dp.observationDate.toISOString().slice(0, 10),
      dataPointId: dp.id,
    },
  };
}

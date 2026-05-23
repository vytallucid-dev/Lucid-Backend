import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

export async function normalHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    forecast_tolerance_pct: number;
  };
  const tolerance = rule.forecast_tolerance_pct;

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

  const actual = Number(dp.value);
  const forecast = dp.forecastValue === null ? null : Number(dp.forecastValue);
  const previous = dp.previousValue === null ? null : Number(dp.previousValue);

  let baseline: number;
  let usedFallback = false;
  if (forecast !== null) {
    baseline = forecast;
  } else if (previous !== null) {
    baseline = previous;
    usedFallback = true;
  } else {
    return {
      kind: 'insufficient_data',
      reason: 'No forecast and no previous reading available',
      details: { indicatorCode: ctx.indicatorCode, dataPointId: dp.id },
    };
  }

  const surprise = Math.round((actual - baseline) * 1e6) / 1e6;
  const tol = Math.round(tolerance * 1e6) / 1e6;

  let score: Score;
  let direction: 'BEAT' | 'MET' | 'MISS';
  if (surprise > tol) {
    score = 1;
    direction = 'BEAT';
  } else if (surprise < -tol) {
    score = -1;
    direction = 'MISS';
  } else {
    score = 0;
    direction = 'MET';
  }

  return {
    kind: 'scored',
    score,
    flags: usedFallback ? ['USED_PREVIOUS_AS_BASELINE'] : [],
    metadata: {
      actual,
      forecast,
      previous,
      surprise,
      tolerance,
      direction,
      used_previous_as_baseline: usedFallback,
      observationDate: dp.observationDate.toISOString().slice(0, 10),
      dataPointId: dp.id,
    },
  };
}

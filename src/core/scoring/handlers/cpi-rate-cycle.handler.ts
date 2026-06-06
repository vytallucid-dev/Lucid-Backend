import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

type Stance = 'CUTTING' | 'NEUTRAL' | 'HIKING';
type Direction = 'BEAT' | 'MET' | 'MISS';

const STANCE_MATRIX: Record<Stance, Record<Direction, Score>> = {
  CUTTING: { BEAT: 1, MET: 0, MISS: -1 },
  NEUTRAL: { BEAT: 1, MET: 0, MISS: -1 },
  HIKING: { BEAT: 1, MET: 1, MISS: 0 },
};

export async function cpiRateCycleHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    currency_code: string;
  };

  const stanceRow = await prisma.currencyCycleStance.findFirst({
    where: {
      currencyCode: rule.currency_code,
      effectiveFrom: { lte: ctx.observationDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: ctx.observationDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  if (!stanceRow) {
    return {
      kind: 'insufficient_data',
      reason: `No active cycle stance for ${rule.currency_code} on ${ctx.observationDate.toISOString().slice(0, 10)}`,
      details: { indicatorCode: ctx.indicatorCode, currencyCode: rule.currency_code },
    };
  }

  const stance = stanceRow.stance as Stance;

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

  const tolerance = 0.05;
  const surprise = Math.round((actual - baseline) * 1e6) / 1e6;
  const tol = Math.round(tolerance * 1e6) / 1e6;

  let direction: Direction;
  if (surprise > tol) direction = 'BEAT';
  else if (surprise < -tol) direction = 'MISS';
  else direction = 'MET';

  const score = STANCE_MATRIX[stance][direction];

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
      stance,
      stance_effective_from: stanceRow.effectiveFrom.toISOString().slice(0, 10),
      used_previous_as_baseline: usedFallback,
      observationDate: dp.observationDate.toISOString().slice(0, 10),
      dataPointId: dp.id,
    },
  };
}

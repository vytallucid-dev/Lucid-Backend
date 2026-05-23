import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

function clamp(value: number, min: number, max: number): Score {
  const clamped = Math.max(min, Math.min(max, value));
  return clamped as Score;
}

export async function twoComponentCpiHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    threshold: { rbi_band_upper: number; well_below: number };
    trajectory: { lookback_months: number; bps_threshold: number };
    bounds: { min: number; max: number };
  };

  const recent = await prisma.dataPoint.findMany({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: ctx.observationDate },
    },
    orderBy: { observationDate: 'desc' },
    take: rule.trajectory.lookback_months + 1,
  });

  if (recent.length === 0) {
    return {
      kind: 'insufficient_data',
      reason: 'No CPI data points found',
    };
  }

  const current = Number(recent[0].value);

  let thresholdScore: -1 | 0 | 1;
  if (current <= rule.threshold.well_below) thresholdScore = 1;
  else if (current <= rule.threshold.rbi_band_upper) thresholdScore = 0;
  else thresholdScore = -1;

  let trajectoryScore: -1 | 0 | 1 | null = null;
  let threeMonthAvg: number | null = null;
  let bpsDiff: number | null = null;

  if (recent.length >= rule.trajectory.lookback_months + 1) {
    const priorPrints = recent
      .slice(1, rule.trajectory.lookback_months + 1)
      .map((d) => Number(d.value));
    threeMonthAvg = priorPrints.reduce((a, b) => a + b, 0) / priorPrints.length;
    bpsDiff = (current - threeMonthAvg) * 100;

    if (bpsDiff <= -rule.trajectory.bps_threshold) trajectoryScore = 1;
    else if (bpsDiff >= rule.trajectory.bps_threshold) trajectoryScore = -1;
    else trajectoryScore = 0;
  }

  const finalScore = clamp(
    thresholdScore + (trajectoryScore ?? 0),
    rule.bounds.min,
    rule.bounds.max,
  );

  const flags: string[] = [];
  if (trajectoryScore === null) flags.push('TRAJECTORY_NULL');

  return {
    kind: 'scored',
    score: finalScore,
    flags,
    metadata: {
      current,
      thresholdScore,
      trajectoryScore,
      threeMonthAvg,
      bpsDiff,
      priorPrintsCount: recent.length - 1,
      observationDate: recent[0].observationDate.toISOString().slice(0, 10),
      dataPointId: recent[0].id,
    },
  };
}

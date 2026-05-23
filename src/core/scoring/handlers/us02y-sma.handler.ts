import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

export async function us02ySmaHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    flat_band_bp: number;
  };
  const flatBand = rule.flat_band_bp;

  const today = await prisma.dataPoint.findFirst({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: ctx.observationDate },
    },
    orderBy: { observationDate: 'desc' },
  });

  if (!today) {
    return {
      kind: 'insufficient_data',
      reason: 'No SMA value on or before observation date',
      details: { indicatorCode: ctx.indicatorCode },
    };
  }

  const yesterday = await prisma.dataPoint.findFirst({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lt: today.observationDate },
    },
    orderBy: { observationDate: 'desc' },
  });

  if (!yesterday) {
    return {
      kind: 'insufficient_data',
      reason: 'No prior SMA value to compare',
      details: { indicatorCode: ctx.indicatorCode, todayDataPointId: today.id },
    };
  }

  const todaySma = Number(today.value);
  const yesterdaySma = Number(yesterday.value);
  const deltaBp = Math.round((todaySma - yesterdaySma) * 100 * 1e6) / 1e6;

  let score: Score;
  let direction: 'RISING' | 'FALLING' | 'FLAT';
  if (deltaBp > flatBand) {
    score = 1;
    direction = 'RISING';
  } else if (deltaBp < -flatBand) {
    score = -1;
    direction = 'FALLING';
  } else {
    score = 0;
    direction = 'FLAT';
  }

  return {
    kind: 'scored',
    score,
    flags: [],
    metadata: {
      today_sma: todaySma,
      today_date: today.observationDate.toISOString().slice(0, 10),
      yesterday_sma: yesterdaySma,
      yesterday_date: yesterday.observationDate.toISOString().slice(0, 10),
      delta_bp: deltaBp,
      flat_band_bp: flatBand,
      direction,
      dataPointId: today.id,
    },
  };
}

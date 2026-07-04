import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

// A day-over-day comparison of a 21-day SMA is damped ~21x versus the raw
// series (only 1 of 21 window points changes per day), so a 1bp dead-band
// sized for raw yield moves absorbs almost every real trend. Comparing over a
// 5-trading-day horizon instead lets a genuine move clear the same 1bp floor
// while still nulling single-day chop — the same shape NIFTY Ind 9's
// scoreSmaDirection() uses to read direction on this series (proven 15/15
// RISING against the identical FLAT-locked day-over-day reads). Horizon is
// trading-day-based (the 5th-prior stored row), not a calendar-day cutoff, so
// weekends/holiday gaps in the stored series don't shrink the window.
const LOOKBACK_TRADING_DAYS = 5;
const REQUIRED_DATA_POINTS = LOOKBACK_TRADING_DAYS + 1; // today + 5 trading days prior

export async function us02ySmaHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    flat_band_bp: number;
  };
  const flatBand = rule.flat_band_bp;

  const rows = await prisma.dataPoint.findMany({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: ctx.observationDate },
    },
    orderBy: { observationDate: 'desc' },
    take: REQUIRED_DATA_POINTS,
  });

  if (rows.length < REQUIRED_DATA_POINTS) {
    return {
      kind: 'insufficient_data',
      reason: `Need ${REQUIRED_DATA_POINTS} stored SMA points (today + ${LOOKBACK_TRADING_DAYS} trading days prior) to compare, found ${rows.length}`,
      details: { indicatorCode: ctx.indicatorCode, required: REQUIRED_DATA_POINTS, found: rows.length },
    };
  }

  const today = rows[0];
  const prior = rows[LOOKBACK_TRADING_DAYS];

  const todaySma = Number(today.value);
  const priorSma = Number(prior.value);
  const deltaBp = Math.round((todaySma - priorSma) * 100 * 1e6) / 1e6;

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
      prior_sma: priorSma,
      prior_date: prior.observationDate.toISOString().slice(0, 10),
      lookback_trading_days: LOOKBACK_TRADING_DAYS,
      delta_bp: deltaBp,
      flat_band_bp: flatBand,
      direction,
      dataPointId: today.id,
    },
  };
}

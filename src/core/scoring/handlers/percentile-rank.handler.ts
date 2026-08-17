import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../types';

interface Band {
  min: number | null;
  max: number | null;
  score: Score;
}

/**
 * Percentile-rank handler. Introduced 2026-08-17 for IND_NIFTY_13_FII_LS_RATIO
 * (v3 scoring_rules row) — replaces the static threshold_bands rule.
 *
 * Scores the current reading by its percentile rank against an EXPANDING
 * window of every prior + current distinct-date observation for the same
 * indicator. Never looks at future data (window is always <= observationDate).
 *
 * Not shared with any other indicator/handler — if a second indicator needs
 * percentile scoring, extend this handler's config rather than hardcoding a
 * second copy elsewhere.
 */
export async function percentileRankHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as {
    bands: Band[];
    min_observations: number;
    contrarian_watch_max_percentile: number;
    contrarian_watch_flag: string;
    historical_default?: Score;
  };

  const currentDp = await prisma.dataPoint.findFirst({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: ctx.observationDate },
    },
    orderBy: { observationDate: 'desc' },
  });

  if (!currentDp) {
    if (rule.historical_default !== undefined) {
      return {
        kind: 'scored',
        score: rule.historical_default,
        flags: ['HISTORICAL_DEFAULT_NO_DATA'],
        metadata: { reason: 'No data point available for or before this date' },
      };
    }
    return { kind: 'insufficient_data', reason: 'No data point found' };
  }

  const currentValue = Number(currentDp.value);
  const currentDate = currentDp.observationDate;

  // Expanding window: every data_points row up to and including currentDate.
  // Collapse duplicate observation dates to the most recent vintage_date —
  // 2026-07-16 has two is_current=true rows (pre-existing ingestion anomaly,
  // out of scope to fix here); ordering by (observationDate asc, vintageDate
  // desc) means the first row seen per date is always the latest vintage.
  const rows = await prisma.dataPoint.findMany({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: currentDate },
    },
    orderBy: [{ observationDate: 'asc' }, { vintageDate: 'desc' }],
  });

  const valueByDate = new Map<string, number>();
  for (const row of rows) {
    const key = row.observationDate.toISOString().slice(0, 10);
    if (!valueByDate.has(key)) valueByDate.set(key, Number(row.value));
  }
  const values = Array.from(valueByDate.values());
  const observationCount = values.length; // distinct dates, not raw rows

  // Percentile rank of currentValue: share of the OTHER observations in the
  // window strictly below it, 0-100. Denominator excludes currentValue's own
  // slot (compares it against every other reading, not itself).
  const percentile =
    observationCount >= 2
      ? (values.filter((v) => v < currentValue).length / (observationCount - 1)) * 100
      : null;

  const observationDateIso = currentDate.toISOString().slice(0, 10);

  if (observationCount < rule.min_observations) {
    return {
      kind: 'scored',
      score: 0,
      flags: ['INSUFFICIENT_HISTORY'],
      metadata: {
        reason: `Insufficient history: ${observationCount}/${rule.min_observations} observations`,
        rawValue: currentValue,
        percentile,
        observationCount,
        observationDate: observationDateIso,
      },
    };
  }

  // observationCount >= min_observations >= 2 here, so percentile is non-null.
  const p = percentile as number;

  let score: Score | null = null;
  for (const band of rule.bands) {
    const aboveMin = band.min === null || p >= band.min;
    const belowMax = band.max === null || p < band.max;
    if (aboveMin && belowMax) {
      score = band.score;
      break;
    }
  }
  if (score === null) {
    return { kind: 'insufficient_data', reason: `Percentile ${p} matched no band` };
  }

  const flags: string[] = [];
  if (p < rule.contrarian_watch_max_percentile) {
    flags.push(rule.contrarian_watch_flag);
  }

  return {
    kind: 'scored',
    score,
    flags,
    metadata: {
      rawValue: currentValue,
      percentile: p,
      observationCount,
      observationDate: observationDateIso,
    },
  };
}

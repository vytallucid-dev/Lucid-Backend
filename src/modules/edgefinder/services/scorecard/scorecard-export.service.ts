import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';

export interface UsdFundamentalsExport {
  observationDate: Date;
  baseFundamentalsScore: number;
  indicatorBreakdown: unknown;
  isToday: boolean;
}

/**
 * Get the most recent USD asset scorecard's base fundamentals score.
 *
 * Returns the latest isCurrent=true USD scorecard regardless of date.
 * isToday=true if scorecard's observationDate matches the provided `today` (UTC).
 * Returns null if no USD scorecard exists at all.
 *
 * Designed for cross-tool consumption (NIFTY Ind 9 bridge). EdgeFinder does
 * not know NIFTY exists — this is a one-way read interface.
 */
export async function getLatestUsdBaseFundamentals(
  today: Date,
): Promise<UsdFundamentalsExport | null> {
  const usd = await prisma.asset.findFirst({
    where: { code: 'USD', toolScope: { has: 'edgefinder' } },
  });
  if (!usd) {
    logger.error('USD asset not found in EdgeFinder scope');
    return null;
  }

  const scorecard = await prisma.edgefinderScorecard.findFirst({
    where: { assetId: usd.id, isCurrent: true },
    orderBy: { observationDate: 'desc' },
  });
  if (!scorecard) {
    logger.warn('No USD scorecard found in edgefinder_scorecards');
    return null;
  }

  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const scoreDateUtc = new Date(
    Date.UTC(
      scorecard.observationDate.getUTCFullYear(),
      scorecard.observationDate.getUTCMonth(),
      scorecard.observationDate.getUTCDate(),
    ),
  );
  const isToday = scoreDateUtc.getTime() === todayUtc.getTime();

  return {
    observationDate: scorecard.observationDate,
    baseFundamentalsScore: Number(scorecard.baseFundamentalsScore),
    indicatorBreakdown: scorecard.indicatorBreakdown,
    isToday,
  };
}

export interface UsdSubIndicatorScoresExport {
  observationDate: Date;
  vintageDate: Date;
  scores: Record<string, number | null>;
}

/**
 * Returns the per-indicator scores for USD's fundamentals on a given observation date.
 * Filters out COT entries; returns only the US sub-indicators.
 *
 * Returns null when no scorecard exists for that date or USD asset not found.
 * Keys are indicator codes (e.g. 'US_CPI_YOY'), values are the score (-1 | 0 | +1) or null.
 *
 * Designed for cross-tool consumption (NIFTY composition flag sub-tool).
 */
export async function getUsdSubIndicatorScoresForDate(
  observationDate: Date,
): Promise<UsdSubIndicatorScoresExport | null> {
  const usdAsset = await prisma.asset.findUnique({ where: { code: 'USD' } });
  if (!usdAsset) {
    logger.error('USD asset not found');
    return null;
  }

  const scorecard = await prisma.edgefinderScorecard.findFirst({
    where: {
      assetId: usdAsset.id,
      observationDate,
      isCurrent: true,
    },
    orderBy: { vintageDate: 'desc' },
  });

  if (!scorecard) return null;

  const breakdown = scorecard.indicatorBreakdown as unknown;
  if (!Array.isArray(breakdown)) return null;

  const scores: Record<string, number | null> = {};
  for (const raw of breakdown) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { indicatorCode?: unknown; score?: unknown; isCot?: unknown };
    if (entry.isCot === true) continue;
    if (typeof entry.indicatorCode !== 'string') continue;
    const score =
      typeof entry.score === 'number' && Number.isFinite(entry.score) ? entry.score : null;
    scores[entry.indicatorCode] = score;
  }

  return {
    observationDate: scorecard.observationDate,
    vintageDate: scorecard.vintageDate,
    scores,
  };
}

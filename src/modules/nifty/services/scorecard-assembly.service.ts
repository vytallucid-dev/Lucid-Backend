import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { computeAllScoresForDate, ComputeAndStoreResult } from '@core/scoring/score-writer.service';
import { computeAutoAnchors, computeVelocity } from './sub-tools/velocity';
import { computePeakScoreState } from './sub-tools/peak-score-ceiling';
import { computeCompositionFlag } from './sub-tools/composition-flag';
import { getUsdSubIndicatorScoresForDate } from '@modules/edgefinder/services/scorecard/scorecard-export.service';
import type { ScorecardHistoryRow, PeakScoreCeilingState } from './sub-tools/types';

function peakScoreStatesEqual(
  a: Prisma.JsonValue | null,
  b: PeakScoreCeilingState,
): boolean {
  if (a === null || a === undefined || typeof a !== 'object') {
    return b.status === 'inactive';
  }
  const av = a as Record<string, unknown>;
  if (av.status !== b.status) return false;
  if (b.status === 'inactive') return true;

  return (
    av.peakDate === b.peakDate &&
    av.peakNetScore === b.peakNetScore &&
    av.entryReason === b.entryReason &&
    av.sessionsSincePeak === b.sessionsSincePeak &&
    av.currentNetScore === b.currentNetScore &&
    Number(av.decayPerDay) === b.decayPerDay &&
    av.decayTier === b.decayTier &&
    av.pendingDeactivation === b.pendingDeactivation &&
    av.sessionsBelowThreshold === b.sessionsBelowThreshold
  );
}

function roundVelocity(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

const DOMESTIC_INDICATORS = [
  'IND_NIFTY_01_PMI_MFG',
  'IND_NIFTY_02_PMI_SVC',
  'IND_NIFTY_03_CPI',
  'IND_NIFTY_04_RBI_RATE',
  'IND_NIFTY_05_IIP',
  'IND_NIFTY_07_DII_ABSORPTION',
];

const EXTERNAL_INDICATORS = [
  'IND_NIFTY_06_FII_FLOW',
  'IND_NIFTY_08_VIX',
  'IND_NIFTY_09_USD_WEAKNESS',
  'IND_NIFTY_10_DXY',
  'IND_NIFTY_11_BRENT',
  'IND_NIFTY_12_USDINR',
];

const IND_13_CODE = 'IND_NIFTY_13_FII_LS_RATIO';
const IND_9_CODE = 'IND_NIFTY_09_USD_WEAKNESS';

const CONFLICT_THRESHOLD = -3;
const TOOL_VERSION = 2;

export interface AssembleScorecardParams {
  observationDate: Date;
  triggeredBy?: string | null;
  triggerType?: 'manual' | 'cron';
}

interface IndicatorBreakdownEntry {
  score: number | null;
  outcome: 'scored' | 'carry_forward' | 'insufficient_data';
  flags: string[];
  reason?: string;
}

export interface AssembleScorecardResult {
  observationDate: string;
  outcome: 'inserted' | 'revised' | 'skipped';
  scorecardId: string;
  netScore: number;
  domesticScore: number;
  externalScore: number;
  band: string;
  ratingLabel: string;
  conflictFlag: boolean;
  ind9RawComposite: number | null;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  missingIndicators: string[];
  indicatorBreakdown: Record<string, IndicatorBreakdownEntry>;
  velocityShort: number | null;
  peakScoreState: PeakScoreCeilingState;
  compositionFlag: string | null;
}

interface RatingBandRule {
  min: number;
  max: number;
  label: string;
}

interface RatingRulesPayload {
  ranges: RatingBandRule[];
  conflict_flag?: { fires_when: string; pattern: string };
  source?: string;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function findBand(netScore: number, rules: RatingBandRule[]): string | null {
  for (const r of rules) {
    if (netScore >= r.min && netScore <= r.max) {
      return r.label;
    }
  }
  return null;
}

async function loadActiveRatingRule(
  observationDate: Date,
): Promise<{ id: string; rules: RatingRulesPayload }> {
  const ratingRule = await prisma.scorecardRatingRule.findFirst({
    where: {
      tool: 'nifty',
      effectiveFrom: { lte: observationDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: observationDate } }],
    },
    orderBy: { version: 'desc' },
  });

  if (!ratingRule) {
    throw new AppError(
      404,
      `No active NIFTY scorecard rating rule for ${toIsoDate(observationDate)}`,
      'NO_ACTIVE_RATING_RULE',
    );
  }

  const rules = ratingRule.rules as unknown as RatingRulesPayload;
  if (!rules.ranges || !Array.isArray(rules.ranges)) {
    throw new AppError(
      500,
      `Rating rule ${ratingRule.id} malformed: missing 'ranges' array`,
      'INVALID_RATING_RULE',
    );
  }

  return { id: ratingRule.id, rules };
}

function buildIndicatorBreakdown(
  scoreResults: ComputeAndStoreResult[],
): Record<string, IndicatorBreakdownEntry> {
  const breakdown: Record<string, IndicatorBreakdownEntry> = {};
  for (const r of scoreResults) {
    breakdown[r.indicatorCode] = {
      score: r.outcome === 'insufficient_data' ? null : r.score ?? null,
      outcome: r.outcome,
      flags: r.flags ?? [],
      ...(r.outcome === 'insufficient_data' ? { reason: r.reason } : {}),
    };
  }
  return breakdown;
}

function sumScoresByCodes(
  breakdown: Record<string, IndicatorBreakdownEntry>,
  codes: string[],
): { sum: number; missing: string[] } {
  let sum = 0;
  const missing: string[] = [];
  for (const code of codes) {
    const entry = breakdown[code];
    if (!entry || entry.score === null) {
      missing.push(code);
      continue;
    }
    sum += entry.score;
  }
  return { sum, missing };
}

function countByPolarity(breakdown: Record<string, IndicatorBreakdownEntry>): {
  positive: number;
  negative: number;
  neutral: number;
} {
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const entry of Object.values(breakdown)) {
    if (entry.score === null) continue;
    if (entry.score > 0) positive++;
    else if (entry.score < 0) negative++;
    else neutral++;
  }
  return { positive, negative, neutral };
}

async function extractInd9RawComposite(
  observationDate: Date,
): Promise<number | null> {
  const ind9Indicator = await prisma.indicator.findUnique({
    where: { code: IND_9_CODE },
  });
  if (!ind9Indicator) return null;

  const ind9Score = await prisma.score.findFirst({
    where: {
      indicatorId: ind9Indicator.id,
      observationDate,
    },
    orderBy: { computedAt: 'desc' },
  });

  if (!ind9Score) return null;

  const meta = (ind9Score.computationMetadata ?? {}) as Record<string, unknown>;
  const raw = meta.rawComposite;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.round(raw);
  }
  return null;
}

interface ScorecardPersistPayload {
  netScore: number;
  domesticScore: number;
  externalScore: number;
  band: string;
  ratingLabel: string;
  conflictFlag: boolean;
  ind9RawComposite: number | null;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  indicatorBreakdown: Record<string, IndicatorBreakdownEntry>;
  missingIndicators: string[];
  velocityShort: number | null;
  peakScoreState: PeakScoreCeilingState;
  compositionFlag: string | null;
}

async function persistScorecard(
  observationDate: Date,
  ratingRuleId: string,
  payload: ScorecardPersistPayload,
): Promise<{ scorecardId: string; outcome: 'inserted' | 'revised' | 'skipped' }> {
  const existing = await prisma.niftyScorecard.findFirst({
    where: { observationDate, isCurrent: true },
    orderBy: { vintageDate: 'desc' },
  });

  if (existing) {
    const velocityIdentical =
      roundVelocity(
        existing.scoreVelocity1d !== null ? Number(existing.scoreVelocity1d) : null,
      ) === roundVelocity(payload.velocityShort);
    const peakStateIdentical = peakScoreStatesEqual(
      existing.peakScoreCeilingState,
      payload.peakScoreState,
    );
    const compositionIdentical = existing.compositionFlag === payload.compositionFlag;

    const identical =
      existing.netScore === payload.netScore &&
      existing.domesticScore === payload.domesticScore &&
      existing.externalScore === payload.externalScore &&
      existing.band === payload.band &&
      existing.conflictFlag === payload.conflictFlag &&
      existing.ind9RawComposite === payload.ind9RawComposite &&
      velocityIdentical &&
      peakStateIdentical &&
      compositionIdentical;

    if (identical) {
      return { scorecardId: existing.id, outcome: 'skipped' };
    }

    return await prisma.$transaction(async (tx) => {
      await tx.niftyScorecard.update({
        where: { id: existing.id },
        data: { isCurrent: false },
      });
      const inserted = await tx.niftyScorecard.create({
        data: {
          observationDate,
          isCurrent: true,
          toolVersion: TOOL_VERSION,
          ratingRuleId,
          netScore: payload.netScore,
          domesticScore: payload.domesticScore,
          externalScore: payload.externalScore,
          ratingLabel: payload.ratingLabel,
          band: payload.band,
          conflictFlag: payload.conflictFlag,
          ind9RawComposite: payload.ind9RawComposite,
          positiveCount: payload.positiveCount,
          negativeCount: payload.negativeCount,
          neutralCount: payload.neutralCount,
          indicatorBreakdown: payload.indicatorBreakdown as unknown as object,
          specialFlags: {
            missingIndicators: payload.missingIndicators,
          } as unknown as object,
          scoreVelocity1d: roundVelocity(payload.velocityShort),
          peakScoreCeilingState: payload.peakScoreState as unknown as object,
          compositionFlag: payload.compositionFlag,
        },
      });
      return { scorecardId: inserted.id, outcome: 'revised' as const };
    });
  }

  const inserted = await prisma.niftyScorecard.create({
    data: {
      observationDate,
      isCurrent: true,
      toolVersion: TOOL_VERSION,
      ratingRuleId,
      netScore: payload.netScore,
      domesticScore: payload.domesticScore,
      externalScore: payload.externalScore,
      ratingLabel: payload.ratingLabel,
      band: payload.band,
      conflictFlag: payload.conflictFlag,
      ind9RawComposite: payload.ind9RawComposite,
      positiveCount: payload.positiveCount,
      negativeCount: payload.negativeCount,
      neutralCount: payload.neutralCount,
      indicatorBreakdown: payload.indicatorBreakdown as unknown as object,
      specialFlags: {
        missingIndicators: payload.missingIndicators,
      } as unknown as object,
      scoreVelocity1d: payload.velocityShort,
      peakScoreCeilingState: payload.peakScoreState as unknown as object,
      compositionFlag: payload.compositionFlag,
    },
  });
  return { scorecardId: inserted.id, outcome: 'inserted' };
}

export async function assembleScorecard(
  params: AssembleScorecardParams,
): Promise<AssembleScorecardResult> {
  const { observationDate } = params;

  logger.info(
    { observationDate: toIsoDate(observationDate) },
    'Starting scorecard assembly',
  );

  const scoreResults = await computeAllScoresForDate(observationDate);

  const ratingRule = await loadActiveRatingRule(observationDate);

  const breakdown = buildIndicatorBreakdown(scoreResults);

  const domestic = sumScoresByCodes(breakdown, DOMESTIC_INDICATORS);
  const external = sumScoresByCodes(breakdown, EXTERNAL_INDICATORS);
  const ind13Entry = breakdown[IND_13_CODE];
  const ind13Score =
    ind13Entry && ind13Entry.score !== null ? ind13Entry.score : 0;
  const ind13Missing = !ind13Entry || ind13Entry.score === null;

  const netScore = domestic.sum + external.sum + ind13Score;

  const missingSet = new Set<string>([
    ...domestic.missing,
    ...external.missing,
    ...(ind13Missing ? [IND_13_CODE] : []),
  ]);
  const missingIndicators = Array.from(missingSet);

  const band = findBand(netScore, ratingRule.rules.ranges);
  if (!band) {
    throw new AppError(
      500,
      `Net score ${netScore} did not match any band in rating rule`,
      'NO_BAND_MATCH',
      { netScore, availableBands: ratingRule.rules.ranges },
    );
  }

  const conflictFlag = external.sum <= CONFLICT_THRESHOLD;

  const ind9RawComposite = await extractInd9RawComposite(observationDate);

  const counts = countByPolarity(breakdown);

  // Sub-tools: load trailing 130 sessions of scorecard history (buffer over 120-session lookback).
  const SUB_TOOLS_HISTORY_DEPTH = 130;
  const historyRows = await prisma.niftyScorecard.findMany({
    where: {
      observationDate: { lt: observationDate },
      isCurrent: true,
    },
    orderBy: { observationDate: 'desc' },
    take: SUB_TOOLS_HISTORY_DEPTH,
    select: {
      observationDate: true,
      netScore: true,
      peakScoreCeilingState: true,
    },
  });

  const history: ScorecardHistoryRow[] = historyRows.map((r) => ({
    observationDate: r.observationDate,
    netScore: r.netScore,
    peakScoreCeilingState: r.peakScoreCeilingState,
  }));

  const currentRow: ScorecardHistoryRow = {
    observationDate,
    netScore,
    peakScoreCeilingState: null,
  };

  // Sub-tool 1: Velocity (default auto-anchor → current)
  const anchors = computeAutoAnchors(currentRow, history);
  const defaultStartRow = anchors.defaultStartDate
    ? history.find(
        (r) => r.observationDate.toISOString().slice(0, 10) === anchors.defaultStartDate,
      ) ?? null
    : null;
  const velocityResult = computeVelocity(defaultStartRow, currentRow, history);
  const velocityShort = velocityResult.velocity;

  // Sub-tool 2: Peak-Score Ceiling
  const priorState = history[0]?.peakScoreCeilingState ?? null;
  const peakScoreState = computePeakScoreState(currentRow, history, priorState);

  // Sub-tool 3: Composition Flag (requires EdgeFinder USD sub-indicators)
  const usdScores = await getUsdSubIndicatorScoresForDate(observationDate);
  const compositionFlag = computeCompositionFlag(
    ind9RawComposite,
    usdScores?.scores ?? {},
  );

  const persistResult = await persistScorecard(observationDate, ratingRule.id, {
    netScore,
    domesticScore: domestic.sum,
    externalScore: external.sum,
    band,
    ratingLabel: band,
    conflictFlag,
    ind9RawComposite,
    positiveCount: counts.positive,
    negativeCount: counts.negative,
    neutralCount: counts.neutral,
    indicatorBreakdown: breakdown,
    missingIndicators,
    velocityShort,
    peakScoreState,
    compositionFlag,
  });

  logger.info(
    {
      observationDate: toIsoDate(observationDate),
      outcome: persistResult.outcome,
      netScore,
      domesticScore: domestic.sum,
      externalScore: external.sum,
      band,
      conflictFlag,
      missingCount: missingIndicators.length,
      velocityShort,
      velocityLabel: velocityResult.label,
      peakScoreActive: peakScoreState.status === 'active',
      compositionFlag,
    },
    'Scorecard assembly complete',
  );

  return {
    observationDate: toIsoDate(observationDate),
    outcome: persistResult.outcome,
    scorecardId: persistResult.scorecardId,
    netScore,
    domesticScore: domestic.sum,
    externalScore: external.sum,
    band,
    ratingLabel: band,
    conflictFlag,
    ind9RawComposite,
    positiveCount: counts.positive,
    negativeCount: counts.negative,
    neutralCount: counts.neutral,
    missingIndicators,
    indicatorBreakdown: breakdown,
    velocityShort,
    peakScoreState,
    compositionFlag,
  };
}

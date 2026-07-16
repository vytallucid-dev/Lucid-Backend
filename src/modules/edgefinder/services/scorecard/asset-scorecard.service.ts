import { Prisma } from '@prisma/client';
import { logger } from '@core/utils/logger';
import { scoreIndicator } from '@core/scoring/engine';
import type { ScoringResult } from '@core/scoring/types';
import {
  edgefinderScorecardsRepository,
  type UpsertScorecardResult,
} from '@core/repositories/edgefinder-scorecards.repository';
import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';
import {
  resolveAssetIndicators,
  type ResolvedIndicator,
} from './asset-indicator-resolver';
import {
  computeCompassOverridesForAsset,
  type IndicatorScoreInput,
  type OverrideEntry,
  type OverrideGateContext,
  type Regime,
} from './compass-overrides';
import { isRegimePathRiskOff } from '@modules/edgefinder/services/compass/compass-override-gates';

export interface AssembleScorecardResult {
  scorecardId: string;
  assetCode: string;
  observationDate: Date;
  baseFundamentalsScore: number;
  fundamentalsScore: number;
  cotScore: number;
  compassAdjustment: number;
  totalScore: number;
  ratingLabel: string;
  regime: Regime;
  action: 'inserted' | 'revised' | 'skipped';
}

interface ScoredIndicator {
  indicator: ResolvedIndicator;
  baseScoreBeforeGoldFlip: number | null;
  score: number | null;
  outcome: 'scored' | 'insufficient_data' | 'carry_forward';
  flags: string[];
  metadata: Record<string, unknown>;
  reason?: string;
}

/**
 * Map an asset total score to a Lucid rating label (Spec v1 §9.2).
 *   >= +4 → Very Support
 *   == +3 → Support
 *   -2..+2 → Neutral
 *   == -3 → Weak
 *   <= -4 → Very Weak
 */
export function mapScoreToLabel(score: number): string {
  if (score >= 4) return 'Very Support';
  if (score === 3) return 'Support';
  if (score <= -4) return 'Very Weak';
  if (score === -3) return 'Weak';
  return 'Neutral';
}

function buildIndicatorBreakdown(
  scored: ScoredIndicator[],
): Prisma.InputJsonValue {
  return scored.map((s) => {
    const meta = s.metadata;
    const direction = typeof meta.direction === 'string' ? meta.direction : null;
    return {
      indicatorCode: s.indicator.indicatorCode,
      score: s.score,
      category: s.indicator.category,
      uiGroup: s.indicator.uiGroup,
      isCot: s.indicator.isCot,
      flipScoreForGold: s.indicator.flipScoreForGold,
      baseScoreBeforeGoldFlip: s.baseScoreBeforeGoldFlip,
      outcome: s.outcome,
      reason: s.reason ?? null,
      direction,
      flags: s.flags,
    };
  });
}

function buildCotBreakdown(cotScored: ScoredIndicator | null): Prisma.InputJsonValue | null {
  if (!cotScored || cotScored.outcome === 'insufficient_data') return null;
  const meta = cotScored.metadata;
  return {
    score: cotScored.score,
    netLabel: meta.netLabel ?? null,
    changeLabel: meta.changeLabel ?? null,
    longPct: meta.longPct ?? null,
    weeklyChangePct: meta.weeklyChangePct ?? null,
    reportDate: meta.reportDate ?? null,
    contractCode: meta.contractCode ?? null,
    traderCategory: meta.traderCategory ?? null,
  };
}

function buildCompassOverridesJson(
  regime: Regime,
  overridesFired: OverrideEntry[],
  totalAdjustment: number,
): Prisma.InputJsonValue | null {
  // Phase 6: gate on whether any override actually fired, not on the regime
  // string — a Trigger B carry shock can fire Override 3 even when
  // final_regime is not Risk-Off.
  if (overridesFired.length === 0) return null;
  return {
    regime,
    overridesFired: overridesFired.map((o) => ({
      code: o.code,
      adjustment: o.adjustment,
      indicatorsAffected: o.indicatorsAffected,
    })),
    totalAdjustment,
  };
}

/**
 * Score one indicator, applying the Gold direction flip when applicable.
 * insufficient_data scores are treated as 0 (so a missing indicator doesn't
 * crash the asset scorecard, but the breakdown records the gap).
 */
async function scoreOneIndicator(
  indicator: ResolvedIndicator,
  observationDate: Date,
): Promise<ScoredIndicator> {
  let result: ScoringResult;
  try {
    result = await scoreIndicator({
      indicatorCode: indicator.indicatorCode,
      observationDate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { indicatorCode: indicator.indicatorCode, message },
      'Scorecard: indicator scoring threw — treating as insufficient_data',
    );
    return {
      indicator,
      baseScoreBeforeGoldFlip: null,
      score: null,
      outcome: 'insufficient_data',
      flags: [],
      metadata: {},
      reason: message,
    };
  }

  if (result.kind === 'insufficient_data') {
    return {
      indicator,
      baseScoreBeforeGoldFlip: null,
      score: null,
      outcome: 'insufficient_data',
      flags: [],
      metadata: result.details ?? {},
      reason: result.reason,
    };
  }

  const rawScore = result.score;
  const finalScore = indicator.flipScoreForGold ? -rawScore : rawScore;

  return {
    indicator,
    baseScoreBeforeGoldFlip: rawScore,
    score: finalScore,
    outcome: result.kind === 'carry_forward' ? 'carry_forward' : 'scored',
    flags: result.flags,
    metadata: result.metadata,
  };
}

/**
 * Assemble the scorecard for a single asset on a given date.
 *
 * Computes per-indicator scores via the existing scoring engine, sums into
 * baseFundamentalsScore + cotScore, fetches the active Compass regime as of
 * the date, applies the Risk-Off overrides, derives totalScore + ratingLabel,
 * and persists via the vintage-aware repository.
 */
export async function assembleAssetScorecard(
  assetCode: string,
  observationDate: Date,
): Promise<AssembleScorecardResult> {
  const mapping = await resolveAssetIndicators(assetCode);

  const scored: ScoredIndicator[] = [];
  for (const ind of mapping.indicators) {
    const s = await scoreOneIndicator(ind, observationDate);
    scored.push(s);
  }

  const fundamentalsScored = scored.filter((s) => !s.indicator.isCot);
  const cotScoredList = scored.filter((s) => s.indicator.isCot);

  const baseFundamentalsScore = fundamentalsScored.reduce(
    (sum, s) => sum + (s.score ?? 0),
    0,
  );
  const cotScore = cotScoredList.reduce((sum, s) => sum + (s.score ?? 0), 0);

  const gateSnapshot = await compassClassificationsRepository.getRegimeGateAsOf(
    observationDate,
  );

  // Phase 6: the override activation path keys off final_regime + the
  // persisted gate decisions, not the bare standard active regime. `regime`
  // (used for regimeAtCompute / the overrides JSON) is the FINAL regime, so a
  // Trigger-A-forced Risk-Off is reflected truthfully.
  let regime: Regime;
  let gate: OverrideGateContext;
  if (gateSnapshot) {
    regime = gateSnapshot.finalRegime;
    const regimePathRiskOff = isRegimePathRiskOff({
      finalRegime: gateSnapshot.finalRegime,
      standardActiveRegime: gateSnapshot.activeRegime,
      shockAActive: gateSnapshot.shockAActive,
    });
    gate = {
      regimePathRiskOff,
      // Override 2 (gold) active iff regime path Risk-Off AND NOT suppressed by
      // the fed-constraint gate (persisted by the classifier).
      override2Active: regimePathRiskOff && !gateSnapshot.override2SuppressedByConstraint,
      // Overrides 3 & 5 active iff (regime path Risk-Off AND NOT suppressed by
      // the rate gate) OR a Trigger B carry-shock bypass.
      override3And5Active:
        (regimePathRiskOff && !gateSnapshot.override3SuppressedByGate) || gateSnapshot.shockBActive,
      shockBActive: gateSnapshot.shockBActive,
    };
  } else {
    regime = 'Caution';
    gate = {
      regimePathRiskOff: false,
      override2Active: false,
      override3And5Active: false,
      shockBActive: false,
    };
    logger.warn(
      {
        assetCode,
        observationDate: observationDate.toISOString().slice(0, 10),
      },
      'No Compass classification on or before date — defaulting regime to Caution',
    );
  }

  const overrideInput: IndicatorScoreInput[] = scored
    .filter((s) => s.score !== null)
    .map((s) => ({
      indicatorCode: s.indicator.indicatorCode,
      baseScore: s.score as number,
      category: s.indicator.category,
    }));

  const overrides = computeCompassOverridesForAsset(assetCode, gate, overrideInput);
  const compassAdjustment = overrides.totalAdjustment;

  const fundamentalsScore = baseFundamentalsScore + compassAdjustment;
  const totalScore = fundamentalsScore + cotScore;
  const ratingLabel = mapScoreToLabel(totalScore);

  const indicatorBreakdown = buildIndicatorBreakdown(scored);
  const cotBreakdown = buildCotBreakdown(cotScoredList[0] ?? null);
  const compassOverridesApplied = buildCompassOverridesJson(
    regime,
    overrides.overridesFired,
    overrides.totalAdjustment,
  );

  const upsert: UpsertScorecardResult = await edgefinderScorecardsRepository.upsert({
    assetId: mapping.assetId,
    observationDate,
    baseFundamentalsScore,
    fundamentalsScore,
    cotScore,
    compassAdjustment,
    compassOverridesApplied,
    regimeAtCompute: regime,
    totalScore,
    ratingLabel,
    indicatorBreakdown,
    cotBreakdown,
  });

  logger.info(
    {
      assetCode,
      observationDate: observationDate.toISOString().slice(0, 10),
      baseFundamentalsScore,
      cotScore,
      compassAdjustment,
      totalScore,
      ratingLabel,
      regime,
      action: upsert.action,
    },
    'EdgeFinder scorecard assembled',
  );

  return {
    scorecardId: upsert.scorecardId,
    assetCode,
    observationDate,
    baseFundamentalsScore,
    fundamentalsScore,
    cotScore,
    compassAdjustment,
    totalScore,
    ratingLabel,
    regime,
    action: upsert.action,
  };
}

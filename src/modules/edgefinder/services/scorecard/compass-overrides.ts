export type Regime = 'Risk-On' | 'Caution' | 'Risk-Off';

export type IndicatorCategory =
  | 'Growth'
  | 'Inflation'
  | 'Jobs'
  | 'Sentiment'
  | 'Rates'
  | 'COT'
  | 'Other';

export interface IndicatorScoreInput {
  indicatorCode: string;
  baseScore: number;
  category: IndicatorCategory;
}

export interface OverrideEntry {
  code: string;
  adjustment: number;
  indicatorsAffected: string[];
}

export interface OverrideAdjustment {
  totalAdjustment: number;
  overridesFired: OverrideEntry[];
}

/**
 * Phase 6 gate context — the classifier's already-resolved, per-date gate
 * decisions, passed in so this function stays pure (no DB/date access). See
 * compass-override-gates.ts for how these are computed.
 *
 *   regimePathRiskOff       = the regime activation path is Risk-Off (either
 *                             the standard machine OR a Trigger A shock).
 *   override2Active         = gold Override 2 permitted (8B: fed CONSTRAINED).
 *   override3And5Active     = JPY Overrides 3 & 5 permitted (8A rate gate, or
 *                             Trigger B bypass).
 *   shockBActive            = carry shock — forces Overrides 3 & 5 even when
 *                             regimePathRiskOff is false (final_regime is not
 *                             changed by Trigger B).
 *
 * Overrides 1 & 4 are UNGATED — they fire whenever regimePathRiskOff, exactly
 * as before (no gate touches them).
 */
export interface OverrideGateContext {
  regimePathRiskOff: boolean;
  override2Active: boolean;
  override3And5Active: boolean;
  shockBActive: boolean;
}

const GOLD_INFLATION_FLIP_CODES = new Set(['US_CPI_YOY', 'US_PPI_MOM', 'US_PCE_YOY']);
const US_JOBS_CODES = new Set([
  'US_NFP',
  'US_UNEMP',
  'US_JOBLESS_CLAIMS',
  'US_ADP',
  'US_JOLTS',
]);

/**
 * Apply Risk-Off Compass overrides for a single asset and return the adjustment
 * to add to the base score.
 *
 * Phase 6: the activation path is the GATE CONTEXT, not a bare
 * `regime === 'Risk-Off'` check — Overrides 1 & 4 (ungated) fire on
 * regimePathRiskOff (which now also captures Trigger-A-forced Risk-Off);
 * Override 2 (gold) additionally requires gate.override2Active (8B fed
 * constraint); Override 3 (JPY) additionally requires gate.override3And5Active
 * (8A rate gate, or a Trigger B bypass). Trigger B can activate 3 even when
 * regimePathRiskOff is false.
 *
 * The overrides assume the caller has already applied the Gold direction flip
 * to baseScore values (so for Gold, a CPI beat shows up as -1 here, and
 * Override 2 flips it back to +1 via a +2 adjustment).
 */
export function computeCompassOverridesForAsset(
  assetCode: string,
  gate: OverrideGateContext,
  indicatorScores: IndicatorScoreInput[],
): OverrideAdjustment {
  const overridesFired: OverrideEntry[] = [];
  let totalAdjustment = 0;

  // Override 2 (Gold): regime path Risk-Off AND fed constraint permits (8B).
  // No shock bypass exists for Override 2.
  if (assetCode === 'XAUUSD' && gate.override2Active) {
    const affected: string[] = [];
    let adj = 0;
    for (const ind of indicatorScores) {
      if (GOLD_INFLATION_FLIP_CODES.has(ind.indicatorCode) && ind.baseScore !== 0) {
        // ind.baseScore is the already-flipped Gold value = -rawUsdScore.
        // Target score = rawUsdScore = -ind.baseScore.
        // Required adjustment = target - current = -ind.baseScore - ind.baseScore = -2 * ind.baseScore.
        adj += -2 * ind.baseScore;
        affected.push(ind.indicatorCode);
      }
    }
    if (affected.length > 0) {
      overridesFired.push({
        code: 'OVERRIDE_2_GOLD_INFLATION_HEDGE',
        adjustment: adj,
        indicatorsAffected: affected,
      });
      totalAdjustment += adj;
    }
  }

  // Override 3 (JPY Safe Haven): gated by 8A (rate gate / Trigger B bypass).
  if (assetCode === 'JPY' && gate.override3And5Active) {
    overridesFired.push({
      code: 'OVERRIDE_3_JPY_SAFE_HAVEN',
      adjustment: 1,
      indicatorsAffected: [],
    });
    totalAdjustment += 1;
  }

  // Override 4 (USD Weak Jobs): UNGATED — fires on the regime path only.
  if (assetCode === 'USD' && gate.regimePathRiskOff) {
    const affected: string[] = [];
    let adj = 0;
    for (const ind of indicatorScores) {
      if (US_JOBS_CODES.has(ind.indicatorCode) && ind.baseScore === -1) {
        adj += 1;
        affected.push(ind.indicatorCode);
      }
    }
    if (adj > 0) {
      overridesFired.push({
        code: 'OVERRIDE_4_USD_WEAK_JOBS',
        adjustment: adj,
        indicatorsAffected: affected,
      });
      totalAdjustment += adj;
    }
  }

  // Override 1 (Bad-News-Good-News): UNGATED — fires on the regime path only.
  if ((assetCode === 'SPY' || assetCode === 'NAS100') && gate.regimePathRiskOff) {
    const affected: string[] = [];
    let adj = 0;
    for (const ind of indicatorScores) {
      if (US_JOBS_CODES.has(ind.indicatorCode) && ind.baseScore === -1) {
        adj += 2;
        affected.push(ind.indicatorCode);
      }
    }
    if (adj > 0) {
      overridesFired.push({
        code: 'OVERRIDE_1_BAD_NEWS_GOOD_NEWS',
        adjustment: adj,
        indicatorsAffected: affected,
      });
      totalAdjustment += adj;
    }
  }

  return { totalAdjustment, overridesFired };
}

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
 * to add to the base score. In Risk-On or Caution: returns zero adjustment.
 *
 * The overrides assume the caller has already applied the Gold direction flip
 * to baseScore values (so for Gold, a CPI beat shows up as -1 here, and
 * Override 2 flips it back to +1 via a +2 adjustment).
 */
export function computeCompassOverridesForAsset(
  assetCode: string,
  regime: Regime,
  indicatorScores: IndicatorScoreInput[],
): OverrideAdjustment {
  if (regime !== 'Risk-Off') {
    return { totalAdjustment: 0, overridesFired: [] };
  }

  const overridesFired: OverrideEntry[] = [];
  let totalAdjustment = 0;

  if (assetCode === 'XAUUSD') {
    const affected: string[] = [];
    let adj = 0;
    for (const ind of indicatorScores) {
      if (GOLD_INFLATION_FLIP_CODES.has(ind.indicatorCode) && ind.baseScore === -1) {
        adj += 2;
        affected.push(ind.indicatorCode);
      }
    }
    if (adj > 0) {
      overridesFired.push({
        code: 'OVERRIDE_2_GOLD_INFLATION_HEDGE',
        adjustment: adj,
        indicatorsAffected: affected,
      });
      totalAdjustment += adj;
    }
  }

  if (assetCode === 'JPY') {
    overridesFired.push({
      code: 'OVERRIDE_3_JPY_SAFE_HAVEN',
      adjustment: 1,
      indicatorsAffected: [],
    });
    totalAdjustment += 1;
  }

  if (assetCode === 'USD') {
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

  if (assetCode === 'SPY' || assetCode === 'NAS100') {
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

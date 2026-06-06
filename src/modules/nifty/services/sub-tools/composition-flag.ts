import { CompositionFlag } from './types';

// Cluster definitions per v2.0 spec Section 3.4
// Maps to EdgeFinder indicator codes (US_*)
export const INFLATION_CLUSTER_CODES = ['US_CPI_YOY', 'US_PPI_YOY', 'US_PCE_YOY'];
export const GROWTH_CLUSTER_CODES = ['US_GDP_QOQ', 'US_ISM_MFG', 'US_ISM_SVC', 'US_RETAIL_MOM'];
export const LABOR_CLUSTER_CODES = [
  'US_NFP',
  'US_UNEMP',
  'US_JOBLESS_CLAIMS',
  'US_ADP',
  'US_JOLTS',
];
// SENTIMENT cluster (US_CB_CONSCONF, US_02Y_SMA) is excluded from flag logic per spec.

const ACTIVATION_THRESHOLD_NEGATIVE = -4;
const ACTIVATION_THRESHOLD_POSITIVE = 4;
const INFLATION_LED_MIN_NEG = 2;
const DEMAND_DESTRUCTION_MIN_GL_NEG = 6;
const DEMAND_DESTRUCTION_MAX_I_NEG = 1;

/**
 * Map of indicator code → score (-1 | 0 | +1, with ±2 collapsed by EdgeFinder upstream).
 * Score convention: USD-bullish = +1, USD-bearish = -1.
 * Matches EdgeFinder's sign convention — `inverted` rules on US_UNEMP / US_JOBLESS_CLAIMS
 * already flip at scoring time.
 */
export interface UsdSubIndicatorScores {
  [indicatorCode: string]: number | null;
}

/**
 * Compute composition flag from Ind 9 raw composite and the 14 USD sub-indicator scores.
 *
 * Returns null when:
 *   - ind9Raw is null
 *   - |ind9Raw| < 4 (not in activation range)
 *   - subIndicators is empty (no EdgeFinder data available)
 *
 * For ind9Raw <= -4 (USD weakness): classifies as INFLATION_LED, DEMAND_DESTRUCTION, or MIXED.
 * For ind9Raw >= +4 (USD strength, mirror): classifies as INFLATION_HOT, DEMAND_REACCEL, or MIXED.
 */
export function computeCompositionFlag(
  ind9Raw: number | null,
  subIndicators: UsdSubIndicatorScores,
): CompositionFlag | null {
  if (ind9Raw === null) return null;
  if (Math.abs(ind9Raw) < ACTIVATION_THRESHOLD_POSITIVE) return null;
  if (!subIndicators || Object.keys(subIndicators).length === 0) return null;

  const countNeg = (codes: string[]): number =>
    codes.reduce(
      (acc, code) =>
        acc +
        (subIndicators[code] !== null && (subIndicators[code] ?? 0) < 0 ? 1 : 0),
      0,
    );
  const countPos = (codes: string[]): number =>
    codes.reduce(
      (acc, code) =>
        acc +
        (subIndicators[code] !== null && (subIndicators[code] ?? 0) > 0 ? 1 : 0),
      0,
    );

  if (ind9Raw <= ACTIVATION_THRESHOLD_NEGATIVE) {
    const iNeg = countNeg(INFLATION_CLUSTER_CODES);
    const glNeg = countNeg(GROWTH_CLUSTER_CODES) + countNeg(LABOR_CLUSTER_CODES);

    if (glNeg >= DEMAND_DESTRUCTION_MIN_GL_NEG && iNeg <= DEMAND_DESTRUCTION_MAX_I_NEG) {
      return 'DEMAND_DESTRUCTION';
    }
    if (iNeg >= INFLATION_LED_MIN_NEG) {
      return 'INFLATION_LED';
    }
    return 'MIXED';
  }

  // ind9Raw >= +4: USD strength direction (mirror flags)
  const iPos = countPos(INFLATION_CLUSTER_CODES);
  const glPos = countPos(GROWTH_CLUSTER_CODES) + countPos(LABOR_CLUSTER_CODES);

  if (glPos >= DEMAND_DESTRUCTION_MIN_GL_NEG && iPos <= DEMAND_DESTRUCTION_MAX_I_NEG) {
    return 'DEMAND_REACCEL';
  }
  if (iPos >= INFLATION_LED_MIN_NEG) {
    return 'INFLATION_HOT';
  }
  return 'MIXED';
}

import type { Regime } from '@modules/edgefinder/services/scorecard/compass-overrides';

export interface PairOverrideEntry {
  code: string;
  adjustment: number;
  pair: string;
}

export interface PairOverrideAdjustment {
  totalAdjustment: number;
  overridesFired: PairOverrideEntry[];
}

/**
 * Compute Compass overrides for pair scoring (Spec v1 §5).
 *
 * Override 3 (JPY Safe Haven): active_regime = 'Risk-Off' and pair has JPY as
 * quote. The JPY asset scorecard's OVERRIDE_3_JPY_SAFE_HAVEN boost is injected
 * as `jpySafeHavenBoost` by the assembly service and applied as a negative
 * adjustment on the pair (stronger JPY quote → weaker pair).
 *   USDJPY: −1   EURJPY: −1   GBPJPY: −1
 *
 * Override 5 (Carry Unwind): active_regime = 'Risk-Off' and pair is EURJPY or
 * GBPJPY. Adjustment: −1.
 *   EURJPY total: −2 (−1 Safe Haven + −1 Carry Unwind)
 *   GBPJPY total: −2 (−1 Safe Haven + −1 Carry Unwind)
 */
export function computePairCompassOverrides(input: {
  pairCode: string;
  regime: Regime;
  /** JPY Safe Haven boost from the JPY asset scorecard (0 when not in Risk-Off). */
  jpySafeHavenBoost?: number;
}): PairOverrideAdjustment {
  if (input.regime !== 'Risk-Off') {
    return { totalAdjustment: 0, overridesFired: [] };
  }

  const overridesFired: PairOverrideEntry[] = [];
  let totalAdjustment = 0;

  // Override 3: JPY Safe Haven — applied to all JPY-quote pairs.
  const JPY_PAIRS = new Set(['USDJPY', 'EURJPY', 'GBPJPY']);
  const safeHavenBoost = input.jpySafeHavenBoost ?? 0;
  if (safeHavenBoost > 0 && JPY_PAIRS.has(input.pairCode)) {
    const adj = -safeHavenBoost;
    overridesFired.push({ code: 'OVERRIDE_3_JPY_SAFE_HAVEN', adjustment: adj, pair: input.pairCode });
    totalAdjustment += adj;
  }

  // Override 5: Carry Unwind — EURJPY and GBPJPY only.
  if (input.pairCode === 'EURJPY' || input.pairCode === 'GBPJPY') {
    overridesFired.push({ code: 'OVERRIDE_5_CARRY_UNWIND', adjustment: -1, pair: input.pairCode });
    totalAdjustment -= 1;
  }

  return { totalAdjustment, overridesFired };
}

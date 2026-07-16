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
 * Compute Compass overrides for pair scoring (Spec v1 §5, Phase 6 gated).
 *
 * Override 3 (JPY Safe Haven): pair has JPY as quote. The JPY asset scorecard's
 * OVERRIDE_3_JPY_SAFE_HAVEN boost is injected as `jpySafeHavenBoost` by the
 * assembly service and applied as a negative adjustment on the pair (stronger
 * JPY quote → weaker pair). Because the JPY asset scorecard only emits that
 * boost when the 8A rate gate permits (or a Trigger B bypass), `jpySafeHavenBoost`
 * is already 0 when Override 3 is suppressed — so no separate gate is needed here.
 *   USDJPY: −1   EURJPY: −1   GBPJPY: −1
 *
 * Override 5 (Carry Unwind): pair is EURJPY or GBPJPY. Adjustment: −1. Gated by
 * the SAME 8A rate gate (`override5Active`) — it's a JPY carry override, so a
 * hawkish rate gate suppresses it exactly like Override 3, and a Trigger B
 * carry shock bypasses it.
 *   EURJPY total: −2 (−1 Safe Haven + −1 Carry Unwind)  [when both active]
 *   GBPJPY total: −2 (−1 Safe Haven + −1 Carry Unwind)
 *
 * The activation path is the gate context (`regimePathRiskOff` OR a Trigger B
 * carry shock), not a bare `regime === 'Risk-Off'` — matching the asset path.
 */
export function computePairCompassOverrides(input: {
  pairCode: string;
  /** The regime activation path is Risk-Off (standard machine OR Trigger A). */
  regimePathRiskOff: boolean;
  /** Override 5 (and 3 propagation) permitted by 8A rate gate / Trigger B bypass. */
  override5Active: boolean;
  /** Carry shock — activates the JPY overrides even when regimePathRiskOff is false. */
  shockBActive: boolean;
  /** JPY Safe Haven boost from the JPY asset scorecard (already gate-suppressed to 0 when 8A blocks). */
  jpySafeHavenBoost?: number;
}): PairOverrideAdjustment {
  // Activation path: the regime path is Risk-Off, OR a Trigger B carry shock
  // forces the JPY overrides on regardless.
  const pathActive = input.regimePathRiskOff || input.shockBActive;
  if (!pathActive) {
    return { totalAdjustment: 0, overridesFired: [] };
  }

  const overridesFired: PairOverrideEntry[] = [];
  let totalAdjustment = 0;

  // Override 3: JPY Safe Haven — applied to all JPY-quote pairs. Already
  // gate-suppressed upstream (jpySafeHavenBoost is 0 when 8A blocks).
  const JPY_PAIRS = new Set(['USDJPY', 'EURJPY', 'GBPJPY']);
  const safeHavenBoost = input.jpySafeHavenBoost ?? 0;
  if (safeHavenBoost > 0 && JPY_PAIRS.has(input.pairCode)) {
    const adj = -safeHavenBoost;
    overridesFired.push({ code: 'OVERRIDE_3_JPY_SAFE_HAVEN', adjustment: adj, pair: input.pairCode });
    totalAdjustment += adj;
  }

  // Override 5: Carry Unwind — EURJPY and GBPJPY only, gated by 8A.
  if ((input.pairCode === 'EURJPY' || input.pairCode === 'GBPJPY') && input.override5Active) {
    overridesFired.push({ code: 'OVERRIDE_5_CARRY_UNWIND', adjustment: -1, pair: input.pairCode });
    totalAdjustment -= 1;
  }

  return { totalAdjustment, overridesFired };
}

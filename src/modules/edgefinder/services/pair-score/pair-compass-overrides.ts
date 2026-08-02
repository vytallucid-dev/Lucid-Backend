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
 *
 * Phase 5: eligibility is `quoteCurrency === 'JPY'`, read from the pair's own
 * definition (base/quote), NOT a hand-maintained pair-code set — the set
 * previously used (USDJPY/EURJPY/GBPJPY) silently excluded AUDJPY, with no
 * error and no log, purely because it was never added to the literal list.
 *   USDJPY: −1   EURJPY: −1   GBPJPY: −1   AUDJPY: −1
 *
 * Override 5 (Carry Unwind): pair is carry-eligible (see `isCarryPair` below).
 * Adjustment: −1. Gated by the SAME 8A rate gate (`override5Active`) — it's a
 * JPY carry override, so a hawkish rate gate suppresses it exactly like
 * Override 3, and a Trigger B carry shock bypasses it.
 *   AUDJPY total: −2 (−1 Safe Haven + −1 Carry Unwind)  [when both active]
 *   EURJPY total: −2 (−1 Safe Haven + −1 Carry Unwind)
 *   GBPJPY total: −2 (−1 Safe Haven + −1 Carry Unwind)
 *
 * The activation path is the gate context (`regimePathRiskOff` OR a Trigger B
 * carry shock), not a bare `regime === 'Risk-Off'` — matching the asset path.
 */
export function computePairCompassOverrides(input: {
  pairCode: string;
  /** Phase 5: the pair's quote currency, from its own definition. Drives
   *  Override 3 eligibility — replaces the hand-maintained JPY_PAIRS set. */
  quoteCurrency: string;
  /**
   * Phase 5: whether this pair is a JPY carry-funding pair, from the pair's
   * own definition (Asset.metadata.isCarryPair — a data property, not derived
   * from a live policy-rate differential: that differential is not already
   * available where this function runs — pair-score.service.ts holds no
   * rate-level data today, only the already-gated jpySafeHavenBoost scalar —
   * and fetching it would mean a new query this phase was told not to add).
   * Drives Override 5 eligibility — replaces the two-pair literal check.
   */
  isCarryPair: boolean;
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

  // Override 3: JPY Safe Haven — applied to every JPY-quote pair, derived from
  // the pair's own quote currency. Already gate-suppressed upstream
  // (jpySafeHavenBoost is 0 when 8A blocks).
  //
  // No pair in the registry has JPY as BASE today. This check only matches
  // quoteCurrency === 'JPY', so a hypothetical JPY-base pair would be silently
  // excluded (zero adjustment), not wrongly signed — the override models
  // "stronger JPY quote weakens the pair" (base − quote), so a JPY-base pair
  // would need the OPPOSITE sign (stronger JPY base strengthens the pair) and
  // an explicit added branch, not a reused condition. That is a deliberate
  // scope boundary, not a defect: no such pair exists to get it wrong for.
  const safeHavenBoost = input.jpySafeHavenBoost ?? 0;
  if (safeHavenBoost > 0 && input.quoteCurrency === 'JPY') {
    const adj = -safeHavenBoost;
    overridesFired.push({ code: 'OVERRIDE_3_JPY_SAFE_HAVEN', adjustment: adj, pair: input.pairCode });
    totalAdjustment += adj;
  }

  // Override 5: Carry Unwind — derived from isCarryPair, gated by 8A.
  if (input.isCarryPair && input.override5Active) {
    overridesFired.push({ code: 'OVERRIDE_5_CARRY_UNWIND', adjustment: -1, pair: input.pairCode });
    totalAdjustment -= 1;
  }

  return { totalAdjustment, overridesFired };
}

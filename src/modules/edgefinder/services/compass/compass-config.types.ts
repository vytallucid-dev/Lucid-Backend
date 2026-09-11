/**
 * Shape of `compass_config.config_definition` (Json). Field names map 1:1 to
 * the literals each evaluator in compass-bands.ts / compass-classifier-logic.ts
 * reads. As of Phase 2A, HY OAS is velocity-based, DXY trend is dev/move5-based,
 * and VIX Term Structure replaces Gold/DXY correlation. As of Phase 2B,
 * yieldCurve holds the inversion-episode state machine's parameters (episode
 * state itself is persisted separately in compass_curve_state, a recomputable
 * cache — see compass-curve-state-machine.ts). As of Phase 4, the crisis
 * clause is retired — `crisisOverride` no longer appears in this type (no
 * code reads it; the v1 row's stored JSON may still carry the key, which is
 * harmless since Json isn't schema-validated) — replaced by `shockLayer`,
 * read by compass-shock-layer.ts. Shock STATE itself is persisted separately
 * in compass_shock_state, a recomputable cache, mirroring compass_curve_state.
 * As of Phase 5, `staleness` holds the forward-fill/staleness limits read by
 * compass-staleness.ts and each input service's cleaned-series builder — see
 * that module for the "trading day" definition (reference-calendar based, no
 * hardcoded holiday list).
 */
export interface CompassConfigDefinition {
  /**
   * The compass_config.version_label this definition came from, stamped onto the
   * object by compassConfigRepository.resolveForDate. It is NOT part of the
   * stored JSON — it exists so every row written during a run can record which
   * config produced it without threading a second parameter through nine ingest
   * services and the classifier.
   */
  versionLabel?: string;

  weights: Record<string, number>;
  vix: { green_below: number; red_above: number };
  hyOas: {
    delta10_red: number;
    delta10_yellow: number;
    level_red: number;
    level_yellow: number;
  };
  yieldCurve: {
    curve_inversion_min_obs: number;
    curve_uninversion_min_obs: number;
    curve_red_window_days: number;
    curve_delta30_floor: number;
  };
  dxyTrend: {
    move5_red: number;
    dev_green: number;
    move5_green: number;
  };
  vixTermStructure: { ts_red_threshold: number; ts_yellow_threshold: number };
  gdpLevel: { green_above: number };
  jobs: { green_avg_above: number; red_avg_below: number };
  usDataStack: { red_majority: number; green_majority: number };
  shockLayer: {
    shock_a_vix_threshold: number;
    shock_a_oas_delta5: number;
    shock_b_usdjpy_move5: number;
    shock_expiry_trading_days: number;
  };
  staleness: {
    stale_limit_market_data_days: number;
    stale_limit_fred_rates_days: number;
    forward_fill_enabled: boolean;
  };
  rateGate: {
    /** false fully reverts to pre-gate behaviour (Overrides 3 & 5 ungated). */
    rate_gate_enabled: boolean;
    /** SMA window for us02y_sma21 (observation-indexed, trailing, inclusive of t). */
    rate_gate_sma_window: number;
    /** Comparison operator. Only 'strict_gt' is implemented (us02y_close > sma). */
    rate_gate_operator: string;
  };
  /**
   * Phase C — the Yields module.
   *
   * R1 (`real_yield_shock_*`) is COMPUTED AND DISPLAYED BUT DOES NOT VOTE in
   * this phase, so it deliberately has no entry in `weights`. Adding it at its
   * proposed weight of 1.5 would take the scale from 8.0 to 9.5 while
   * redRiskOffAt (3.5) and greenRiskOnAt (5.0) stayed calibrated for 8.0,
   * silently loosening both by ~16%. That rescaling is a separate, evidenced
   * decision, not a side effect.
   *
   * `curve_green_requires_no_real_shock` is the one scoring change that DOES
   * ship. As built, the 2s10s GREEN clause (`t10y2y >= 0 AND delta30 >= floor`)
   * fires during bear steepeners, so the curve voted GREEN at the term-premium
   * peak in 26 of 28 episodes and on 76.9% of days inside episodes against
   * 49.3% outside. It votes MORE positively during long-end stress than at
   * other times. This gate stops the GREEN clause firing while R1 is RED.
   *
   * Note this makes R1 a scoring DEPENDENCY at zero weight, which is intended.
   * Note also that DFII10 starts 2003-01-02, so the gate is inert before then.
   *
   * OPTIONAL because v1 and v2 genuinely predate it. A config without this block
   * behaves exactly as it did before Phase C: no R1 bands, no curve gate. The
   * replay runs historical windows under the v2 config and must not crash.
   */
  yields?: {
    real_yield_shock_60d_red_bp: number;
    real_yield_shock_60d_yellow_bp: number;
    curve_green_requires_no_real_shock: boolean;
  };
  candidateRegime: { redRiskOffAt: number; greenRiskOnAt: number; redRiskOnCeiling: number };
  persistence: { daysToHigherSeverity: number; daysToLowerSeverity: number };
}

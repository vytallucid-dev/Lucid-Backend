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
  candidateRegime: { redRiskOffAt: number; greenRiskOnAt: number; redRiskOnCeiling: number };
  persistence: { daysToHigherSeverity: number; daysToLowerSeverity: number };
}

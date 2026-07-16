import type { CompassConfigDefinition } from '@modules/edgefinder/services/compass/compass-config.types';

/** Mirrors the seeded, active v2 compass_config row exactly — for unit tests only. */
export const COMPASS_CONFIG_V1_FIXTURE: CompassConfigDefinition = {
  weights: {
    VIX_5D_AVG: 1.0,
    VIX_TERM_STRUCTURE: 1.5,
    HY_OAS: 1.5,
    YIELD_2S10S: 1.0,
    DXY_TREND: 1.0,
    US_DATA_STACK: 2.0,
  },
  vix: { green_below: 18, red_above: 25 },
  hyOas: {
    delta10_red: 0.75,
    delta10_yellow: 0.4,
    level_red: 5.5,
    level_yellow: 4.5,
  },
  yieldCurve: {
    curve_inversion_min_obs: 10,
    curve_uninversion_min_obs: 5,
    curve_red_window_days: 60,
    curve_delta30_floor: -0.05,
  },
  dxyTrend: {
    move5_red: 0.03,
    dev_green: 0.02,
    move5_green: 0.02,
  },
  vixTermStructure: { ts_red_threshold: 1.0, ts_yellow_threshold: 0.9 },
  gdpLevel: { green_above: 1.5 },
  jobs: { green_avg_above: 100, red_avg_below: 50 },
  usDataStack: { red_majority: 2, green_majority: 2 },
  shockLayer: {
    shock_a_vix_threshold: 32.0,
    shock_a_oas_delta5: 0.5,
    shock_b_usdjpy_move5: -0.025,
    shock_expiry_trading_days: 10,
  },
  staleness: {
    stale_limit_market_data_days: 3,
    stale_limit_fred_rates_days: 5,
    forward_fill_enabled: true,
  },
  rateGate: {
    rate_gate_enabled: true,
    rate_gate_sma_window: 21,
    rate_gate_operator: 'strict_gt',
  },
  candidateRegime: { redRiskOffAt: 3.5, greenRiskOnAt: 5.0, redRiskOnCeiling: 1.0 },
  persistence: { daysToHigherSeverity: 3, daysToLowerSeverity: 5 },
};

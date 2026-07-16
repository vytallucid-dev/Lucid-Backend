/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Compass v2 seed. Phase 2A activated the "v2" config row (VIX Term
 * Structure replaces Gold/DXY correlation, HY OAS velocity-based, DXY trend
 * direction corrected, 2s10s weight reduced) and closed off "v1" the day
 * before activation. Phase 2B replaces yieldCurve's shape with the
 * inversion-episode state machine's parameters (curve_inversion_min_obs,
 * curve_uninversion_min_obs, curve_red_window_days, curve_delta30_floor) —
 * episode STATE itself lives in compass_curve_state, not here; this is only
 * the state machine's tunable thresholds. Phase 3 reshapes `persistence`
 * into the asymmetric machine's two thresholds (daysToHigherSeverity /
 * daysToLowerSeverity) — no new table; pending_label is derived from the
 * prior classification row (see compass-classifier-logic.ts).
 *
 * Phase 4 retires the v1 crisis clause and replaces it with the Shock
 * Layer's config keys (shockLayer, replacing crisisOverride) on the ACTIVE
 * v2 row only — v1's crisisOverride block is left as-is (v1 is inactive,
 * historical). Shock STATE lives in compass_shock_state, not here.
 *
 * Phase 5 adds `staleness` (stale_limit_market_data_days,
 * stale_limit_fred_rates_days, forward_fill_enabled) to both rows — no new
 * table; forward-filled values are computation-time only (never persisted),
 * and stale flags live inside each compass_inputs row's existing subChecks
 * JSON (see compass-staleness.ts).
 *
 * Idempotent via upsert on the versionLabel unique key. Unlike Phase 1's
 * upsert (update: {}, a pure no-op on rerun), this seed's `update` clause
 * actively re-applies configDefinition/effectiveFrom/effectiveTo/notes so a
 * rerun after editing this file actually activates the new values — required
 * for the v1->v2 cutover, since the v2 row already exists from Phase 1 with
 * a 2099-01-01 placeholder effectiveFrom that must be overwritten.
 */

const V1_EFFECTIVE_FROM = new Date('2026-01-01');
const V1_EFFECTIVE_TO = new Date('2026-07-15');
const V2_EFFECTIVE_FROM = new Date('2026-07-16'); // Phase 2A activation date

// v1's original level/30d-change HY OAS and pct-based DXY trend logic no
// longer exists in code (compass-bands.ts now only implements the v2-shaped
// velocity/dev-move5 formulas). These v1 config values are re-keyed under the
// new field names using v1's original thresholds translated as literally as
// possible, SOLELY so a rerun over the v1 date window (2026-01-01 to
// 2026-07-15) does not crash on missing config keys. This does NOT reproduce
// v1's original historical output under the new formulas — that is expected;
// already-persisted v1-era compass_classifications rows are untouched.
const COMPASS_CONFIG_V1 = {
  weights: {
    VIX_5D_AVG: 1.0,
    HY_OAS: 1.5,
    YIELD_2S10S: 1.5,
    DXY_TREND: 1.0,
    VIX_TERM_STRUCTURE: 1.0,
    US_DATA_STACK: 2.0,
  },
  vix: { green_below: 18, red_above: 25 },
  hyOas: {
    delta10_red: 999, // no historical v1 velocity threshold existed; set unreachable so level dominates
    delta10_yellow: 999,
    level_red: 7.0,
    level_yellow: 4.5,
  },
  // v1 never had an inversion-episode concept; these are simply the v2
  // values so a rerun over the v1 window uses the same (only) implemented
  // state machine rather than crashing on missing keys.
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
  crisisOverride: { vix_above: 30, hy_oas_above: 7.0 },
  // Phase 5 shape-compat only (v1 is inactive/historical) — see COMPASS_CONFIG_V2's
  // staleness block for the real values.
  staleness: {
    stale_limit_market_data_days: 3,
    stale_limit_fred_rates_days: 5,
    forward_fill_enabled: true,
  },
  // Phase 6 shape-compat only (v1 inactive) — see v2's rateGate for real values.
  rateGate: {
    rate_gate_enabled: true,
    rate_gate_sma_window: 21,
    rate_gate_operator: 'strict_gt',
  },
  candidateRegime: { redRiskOffAt: 4, greenRiskOnAt: 5, redRiskOnCeiling: 1 },
  // v1 never had an asymmetric persistence concept (flat 5-day rule for any
  // direction); shape-matched to v2 with daysToHigherSeverity=5 (same as
  // daysToLowerSeverity) so a rerun over the v1 window doesn't crash on
  // missing keys. This is shape consistency only, not a behavior claim —
  // v1 is inactive (effectiveTo 2026-07-15).
  persistence: { daysToHigherSeverity: 5, daysToLowerSeverity: 5 },
};

const COMPASS_CONFIG_V2 = {
  weights: {
    VIX_5D_AVG: 1.0,
    VIX_TERM_STRUCTURE: 1.5,
    HY_OAS: 1.5,
    YIELD_2S10S: 1.0,
    DXY_TREND: 1.0,
    US_DATA_STACK: 2.0,
  },
  vix: { green_below: 18.0, red_above: 25.0 },
  yieldCurve: {
    curve_inversion_min_obs: 10,
    curve_uninversion_min_obs: 5,
    curve_red_window_days: 60,
    curve_delta30_floor: -0.05,
  },
  hyOas: {
    delta10_red: 0.75,
    delta10_yellow: 0.4,
    level_red: 5.5,
    level_yellow: 4.5,
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
  // Phase 4: retires the crisis clause. Trigger A (Vol Shock) now serves the
  // same-day Risk-Off bypass; Trigger B (Carry Shock) is computed/persisted
  // but does not yet change overrides (Phase 6 wires that).
  shockLayer: {
    shock_a_vix_threshold: 32.0,
    shock_a_oas_delta5: 0.5,
    shock_b_usdjpy_move5: -0.025,
    shock_expiry_trading_days: 10,
  },
  // Phase 5: staleness/forward-fill limits. Market-data series (VIX, VIX3M,
  // DXY, USDJPY) get a 3-trading-day fill window; FRED rate series (HY OAS,
  // T10Y2Y) get 5 (slower-updating, wider tolerance). CPI/GDP/PAYEMS/UNRATE
  // have no staleness concept (always-latest-print) and read neither key.
  staleness: {
    stale_limit_market_data_days: 3,
    stale_limit_fred_rates_days: 5,
    forward_fill_enabled: true,
  },
  // Phase 6 (Addendum 8A): the rate gate on JPY safe-haven Overrides 3 & 5.
  // rate_gate_enabled=false fully reverts to pre-gate behaviour. The SMA is a
  // 21-observation trailing window over the Compass-local DGS2 series
  // (US02Y_CLOSE); operator is strict > (equality → not hawkish → overrides
  // apply). The Fed-constraint gate (8B) lives in currency_cycle_stance, NOT
  // here (it's an override-input judgment value, not a classifier constant).
  rateGate: {
    rate_gate_enabled: true,
    rate_gate_sma_window: 21,
    rate_gate_operator: 'strict_gt',
  },
  candidateRegime: { redRiskOffAt: 3.5, greenRiskOnAt: 5.0, redRiskOnCeiling: 1.0 },
  // Phase 3: asymmetric persistence — 3 days to confirm a move toward HIGHER
  // severity (Risk-On -> Caution -> Risk-Off), 5 days toward LOWER severity.
  persistence: { daysToHigherSeverity: 3, daysToLowerSeverity: 5 },
};

async function seedCompassConfig(): Promise<void> {
  await prisma.compassConfig.upsert({
    where: { versionLabel: 'v1' },
    update: {
      configDefinition: COMPASS_CONFIG_V1,
      effectiveFrom: V1_EFFECTIVE_FROM,
      effectiveTo: V1_EFFECTIVE_TO,
      notes:
        'Compass v1 — closed off at Phase 2A activation. Re-keyed under v2-shaped field names so a rerun over the v1 window does not crash; does not reproduce original v1 output under the new formulas.',
    },
    create: {
      versionLabel: 'v1',
      configDefinition: COMPASS_CONFIG_V1,
      effectiveFrom: V1_EFFECTIVE_FROM,
      effectiveTo: V1_EFFECTIVE_TO,
      notes:
        'Compass v1 — closed off at Phase 2A activation. Re-keyed under v2-shaped field names so a rerun over the v1 window does not crash; does not reproduce original v1 output under the new formulas.',
    },
  });
  console.log(`Seeded compass_config v1 (effectiveFrom=${V1_EFFECTIVE_FROM.toISOString().slice(0, 10)}, effectiveTo=${V1_EFFECTIVE_TO.toISOString().slice(0, 10)})`);

  await prisma.compassConfig.upsert({
    where: { versionLabel: 'v2' },
    update: {
      configDefinition: COMPASS_CONFIG_V2,
      effectiveFrom: V2_EFFECTIVE_FROM,
      effectiveTo: null,
      notes: 'Compass v2 — Phase 2A: VIX Term Structure replaces Gold/DXY correlation, HY OAS velocity-based, DXY trend direction corrected, 2s10s weight reduced to 1.0. Phase 2B: 2s10s rescored to the inversion-episode state machine (curve_* keys); episode state cached in compass_curve_state. Phase 3: persistence reshaped to the asymmetric machine (3 days toward higher severity, 5 toward lower). Phase 4: crisis clause retired, replaced by the Shock Layer (Trigger A/B, shockLayer keys); shock state cached in compass_shock_state; final_regime/shock_a_active/shock_b_active added to compass_classifications. Phase 5: staleness/forward-fill (staleness keys) + observation-indexed lookbacks; USDJPY history-gap fix so Trigger B can compute. Phase 6: override gates — rate gate (rateGate keys) on JPY Overrides 3&5 with Trigger B bypass, fed-constraint gate on gold Override 2 (fed_constraint lives in currency_cycle_stance); US02Y_CLOSE plumbing input; gate audit columns on compass_classifications.',
    },
    create: {
      versionLabel: 'v2',
      configDefinition: COMPASS_CONFIG_V2,
      effectiveFrom: V2_EFFECTIVE_FROM,
      effectiveTo: null,
      notes: 'Compass v2 — Phase 2A: VIX Term Structure replaces Gold/DXY correlation, HY OAS velocity-based, DXY trend direction corrected, 2s10s weight reduced to 1.0. Phase 2B: 2s10s rescored to the inversion-episode state machine (curve_* keys); episode state cached in compass_curve_state. Phase 3: persistence reshaped to the asymmetric machine (3 days toward higher severity, 5 toward lower). Phase 4: crisis clause retired, replaced by the Shock Layer (Trigger A/B, shockLayer keys); shock state cached in compass_shock_state; final_regime/shock_a_active/shock_b_active added to compass_classifications. Phase 5: staleness/forward-fill (staleness keys) + observation-indexed lookbacks; USDJPY history-gap fix so Trigger B can compute. Phase 6: override gates — rate gate (rateGate keys) on JPY Overrides 3&5 with Trigger B bypass, fed-constraint gate on gold Override 2 (fed_constraint lives in currency_cycle_stance); US02Y_CLOSE plumbing input; gate audit columns on compass_classifications.',
    },
  });
  console.log(`Seeded compass_config v2 (effectiveFrom=${V2_EFFECTIVE_FROM.toISOString().slice(0, 10)}, ACTIVE)`);
}

async function main(): Promise<void> {
  await seedCompassConfig();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

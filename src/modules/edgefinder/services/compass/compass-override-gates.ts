/**
 * Phase 6 override gates (Addenda 8A + 8B) — PURE logic, no I/O.
 *
 * The two override files (compass-overrides.ts, pair-compass-overrides.ts) are
 * pure functions with no DB/date access. The gate INPUTS (the rate-gate
 * hawkish flag, the shock flags, the standard/final regime, the fed
 * constraint) are resolved by the assembly services (which have the date and
 * DB) and passed in. This module turns those resolved inputs into the two
 * gate decisions, keeping the override functions themselves pure and keeping
 * the load-bearing Trigger A/B asymmetry in exactly one place.
 *
 * Addendum 8A (rate gate) — gates the JPY safe-haven / carry overrides (3 & 5):
 *   rate_gate_hawkish = us02y_close(t) > us02y_sma21(t)   (strict >, 6-dp rounded)
 *   Trigger B ALWAYS bypasses the gate (price-proven carry unwind overrules an
 *   assumption-based rate differential). Trigger A does NOT bypass (a vol/credit
 *   shock proves nothing about JPY direction, so it stays gated).
 *
 * Addendum 8B (fed constraint) — gates the gold override (2):
 *   override_2_active = regime_path_riskoff AND fed_constraint == CONSTRAINED
 *   NO shock bypass exists for Override 2 — Trigger A still routes through it.
 */

import type { Regime } from './compass-classifier-logic';
import type { FedConstraint } from './fed-constraint.resolver';

const RISK_OFF: Regime = 'Risk-Off';

/**
 * Round to 6 decimals for the rate-gate comparison. Values are Decimal(20,6)
 * in storage; the gate must compare AFTER rounding so an equal-to-6-dp pair
 * resolves to NOT hawkish (overrides apply), per spec.
 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface RegimePathInput {
  finalRegime: Regime;
  standardActiveRegime: Regime;
  shockAActive: boolean;
}

/**
 * regime_path_riskoff = (final_regime == RISK_OFF)
 *                       AND (shock_a_active OR standard_active_regime == RISK_OFF)
 *
 * True when the regime is genuinely Risk-Off by EITHER the standard machine
 * OR a Trigger A shock — the activation path for Overrides 2/3/5.
 */
export function isRegimePathRiskOff(input: RegimePathInput): boolean {
  return (
    input.finalRegime === RISK_OFF &&
    (input.shockAActive || input.standardActiveRegime === RISK_OFF)
  );
}

/**
 * rate_gate_hawkish(t) = us02y_close(t) > us02y_sma21(t), strict, 6-dp rounded.
 * Equality after rounding → NOT hawkish (returns false → overrides apply).
 * Either value null (couldn't compute) → returns null (caller fails OPEN).
 */
export function computeRateGateHawkish(
  us02yClose: number | null,
  us02ySma21: number | null,
): boolean | null {
  if (us02yClose === null || us02ySma21 === null) return null;
  return round6(us02yClose) > round6(us02ySma21);
}

export interface RateGateInput {
  /** Master enable flag from compass_config.rateGate.rate_gate_enabled. */
  enabled: boolean;
  /** true = the regime activation path is Risk-Off (isRegimePathRiskOff). */
  regimePathRiskOff: boolean;
  /**
   * rate_gate_hawkish result. `null` means it could not be computed reliably
   * (US02Y stale beyond limit / insufficient history) → the gate FAILS OPEN
   * (treated as NOT hawkish, overrides apply) and staleFlag is set.
   */
  rateGateHawkish: boolean | null;
  /** Trigger B active — ALWAYS bypasses the rate gate. */
  shockBActive: boolean;
}

export interface RateGateResult {
  /** Whether Overrides 3 & 5 are active (fire) after the gate. */
  overridesActive: boolean;
  /** Whether the gate SUPPRESSED an otherwise-active regime-path override. */
  suppressedByGate: boolean;
  /** The hawkish value actually used (null → false via fail-open), for the audit log. */
  hawkishResolved: boolean;
  /** True when rateGateHawkish was null and the gate failed open. */
  staleFailedOpen: boolean;
}

/**
 * Addendum 8A gate for Overrides 3 & 5 (JPY). Exact spec logic:
 *
 *   if rate_gate_hawkish: override_{3,5}_regime_allowed = FALSE else TRUE
 *   override_{3,5}_active = (regime_path_riskoff AND regime_allowed) OR shock_b_active
 *
 * When rate_gate_enabled is false, the gate reverts fully to pre-gate
 * behaviour: overrides active iff regime_path_riskoff (or Trigger B), never
 * suppressed.
 */
export function evaluateRateGate(input: RateGateInput): RateGateResult {
  const staleFailedOpen = input.rateGateHawkish === null;
  // Fail OPEN: a null (uncomputable) hawkish result is treated as NOT hawkish.
  const hawkishResolved = input.rateGateHawkish === true;

  // Gate disabled → regime path is always "allowed" (pre-gate behaviour).
  const regimeAllowed = !input.enabled ? true : !hawkishResolved;

  const regimePathActive = input.regimePathRiskOff && regimeAllowed;
  const overridesActive = regimePathActive || input.shockBActive;

  // Suppressed only when the regime path WOULD have fired but the gate blocked
  // it AND Trigger B didn't rescue it. (If Trigger B is active, nothing was
  // suppressed — the overrides fire regardless.)
  const suppressedByGate =
    input.enabled &&
    input.regimePathRiskOff &&
    hawkishResolved &&
    !input.shockBActive;

  return { overridesActive, suppressedByGate, hawkishResolved, staleFailedOpen };
}

export interface FedConstraintGateInput {
  /** true = the regime activation path is Risk-Off (isRegimePathRiskOff). */
  regimePathRiskOff: boolean;
  /** Resolved Fed constraint as of t. Default/fail-safe is FREE. */
  fedConstraint: FedConstraint;
}

export interface FedConstraintGateResult {
  /** Whether Override 2 (gold) is active (fires) after the gate. */
  overrideActive: boolean;
  /** Whether the gate SUPPRESSED an otherwise-active regime-path override. */
  suppressedByConstraint: boolean;
}

/**
 * Addendum 8B gate for Override 2 (Gold). Exact spec logic:
 *
 *   override_2_active = regime_path_riskoff AND (fed_constraint == CONSTRAINED)
 *
 * NO shock-layer bypass exists — Trigger A activating Risk-Off still routes
 * through this gate. FREE (the default) suppresses; CONSTRAINED applies.
 */
export function evaluateFedConstraintGate(
  input: FedConstraintGateInput,
): FedConstraintGateResult {
  const overrideActive = input.regimePathRiskOff && input.fedConstraint === 'CONSTRAINED';
  const suppressedByConstraint = input.regimePathRiskOff && input.fedConstraint === 'FREE';
  return { overrideActive, suppressedByConstraint };
}

/**
 * Observation-indexed 21-observation trailing SMA of a cleaned US02Y series
 * (Phase 5 convention — forward-filled values count as observations). Returns
 * null if fewer than `window` observations exist (insufficient history — the
 * caller fails the rate gate OPEN). The `series` must already be cleaned
 * (ascending, forward-filled, ending at t) via compass-staleness.ts.
 */
export function computeUs02ySma(series: number[], window: number): number | null {
  if (series.length < window) return null;
  const lastN = series.slice(-window);
  return lastN.reduce((sum, v) => sum + v, 0) / window;
}

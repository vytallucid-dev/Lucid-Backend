import type { ColorBand } from './compass-bands';
import type { CompassConfigDefinition } from './compass-config.types';

export type Regime = 'Risk-On' | 'Caution' | 'Risk-Off';

export interface VoteWeights {
  green: number;
  yellow: number;
  red: number;
}

export interface InputWithBand {
  inputCode: string;
  colorBand: ColorBand;
}

/**
 * Sum weights of inputs grouped by color band.
 * Throws if an inputCode is not in config.weights.
 */
export function sumVoteWeights(
  inputs: InputWithBand[],
  config: CompassConfigDefinition,
): VoteWeights {
  const totals: VoteWeights = { green: 0, yellow: 0, red: 0 };
  for (const input of inputs) {
    const weight = config.weights[input.inputCode];
    if (weight === undefined) {
      throw new Error(`Unknown input code: ${input.inputCode}`);
    }
    if (input.colorBand === 'GREEN') totals.green += weight;
    else if (input.colorBand === 'YELLOW') totals.yellow += weight;
    else if (input.colorBand === 'RED') totals.red += weight;
  }
  return totals;
}

export interface CandidateInput {
  voteWeights: VoteWeights;
}

/**
 * Determine candidate regime from vote weights alone.
 *
 * Phase 4 retires the crisis clause (checkCrisisOverride) — same-day shock
 * detection is now the Shock Layer's Trigger A, evaluated separately in
 * compass-classifier.service.ts AFTER this function and AFTER the
 * persistence machine, and Trigger A never feeds back into candidate/active
 * regime computation. This function and resolveActiveRegime below are
 * unaware of shocks entirely, by design (see compass-shock-layer.ts).
 */
export function determineCandidateRegime(
  input: CandidateInput,
  config: CompassConfigDefinition,
): Regime {
  const { green, red } = input.voteWeights;
  if (red >= config.candidateRegime.redRiskOffAt) return 'Risk-Off';
  if (green >= config.candidateRegime.greenRiskOnAt && red <= config.candidateRegime.redRiskOnCeiling) return 'Risk-On';
  return 'Caution';
}

export interface PriorClassification {
  activeRegime: Regime;
  candidateRegime: Regime;
  persistenceDaysCount: number;
}

export interface ActiveRegimeResolution {
  activeRegime: Regime;
  persistenceDaysCount: number;
}

export interface ResolveActiveRegimeInput {
  candidateRegime: Regime;
  prior: PriorClassification | null;
}

/** Severity ordering for the asymmetric persistence machine: higher = more severe. */
const REGIME_SEVERITY: Record<Regime, number> = {
  'Risk-On': 0,
  Caution: 1,
  'Risk-Off': 2,
};

/**
 * Resolve today's active regime given today's raw candidate and the prior
 * day's state — the v2 asymmetric persistence machine.
 *
 * Per-day state is (active_regime, pending_label, pending_count). Only
 * active_regime and persistenceDaysCount (== pending_count) are persisted;
 * pending_label is NOT stored as its own column. It is recovered from
 * `prior.candidateRegime` whenever `prior.persistenceDaysCount > 0` — sound
 * because the classifier always persists that day's own raw candidate as
 * candidateRegime on that row (see compass-classifier.service.ts), and this
 * machine always sets pending_label := raw_label on any day it doesn't
 * clear pending entirely. So prior.candidateRegime IS prior's pending_label
 * whenever prior.persistenceDaysCount > 0; when it's 0, pending is null.
 *
 * Phase 4: this machine runs EVERY day, unconditionally, with NO awareness
 * of the Shock Layer — a shock never writes to active_regime, pending_label,
 * or pending_count (see compass-shock-layer.ts / compass-classifier.service.ts,
 * which apply the shock's Risk-Off override to a separate `final_regime`
 * field AFTER this function runs, leaving this machine's own state exactly
 * as if no shock existed).
 *
 * Rules:
 *   1. Bootstrap (no prior) → active=Caution; candidate==Caution clears
 *      pending (count=0), otherwise this is day 1 of a new pending streak
 *      (count=1).
 *   2. Normal, every day unconditionally:
 *      a. candidate == prior.activeRegime → pending cleared (count=0).
 *      b. otherwise → pending_label = candidate (continuing if it matches
 *         prior's pending_label, else resetting to count=1); required is
 *         3 if severity(candidate) > severity(prior.activeRegime) else 5;
 *         if the new count >= required → active flips directly to
 *         candidate (regardless of how many severity steps away it is),
 *         count resets to 0.
 */
export function resolveActiveRegime(
  input: ResolveActiveRegimeInput,
  config: CompassConfigDefinition,
): ActiveRegimeResolution {
  if (input.prior === null) {
    return {
      activeRegime: 'Caution',
      persistenceDaysCount: input.candidateRegime === 'Caution' ? 0 : 1,
    };
  }

  if (input.candidateRegime === input.prior.activeRegime) {
    return {
      activeRegime: input.prior.activeRegime,
      persistenceDaysCount: 0,
    };
  }

  // pending_label as of `prior`: prior.candidateRegime whenever
  // prior.persistenceDaysCount > 0, else there was no pending streak.
  const priorPendingLabel: Regime | null =
    input.prior.persistenceDaysCount > 0 ? input.prior.candidateRegime : null;

  const newCount =
    input.candidateRegime === priorPendingLabel
      ? input.prior.persistenceDaysCount + 1
      : 1;

  const required =
    REGIME_SEVERITY[input.candidateRegime] > REGIME_SEVERITY[input.prior.activeRegime]
      ? config.persistence.daysToHigherSeverity
      : config.persistence.daysToLowerSeverity;

  if (newCount >= required) {
    return {
      activeRegime: input.candidateRegime,
      persistenceDaysCount: 0,
    };
  }

  return {
    activeRegime: input.prior.activeRegime,
    persistenceDaysCount: newCount,
  };
}

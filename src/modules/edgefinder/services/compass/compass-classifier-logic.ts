import type { ColorBand } from './compass-bands';

export const COMPASS_INPUT_WEIGHTS: Record<string, number> = {
  VIX_5D_AVG: 1.0,
  HY_OAS: 1.5,
  YIELD_2S10S: 1.5,
  DXY_TREND: 1.0,
  GOLD_DXY_CORR: 1.0,
  US_DATA_STACK: 2.0,
};

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
 * Throws if an inputCode is not in COMPASS_INPUT_WEIGHTS.
 */
export function sumVoteWeights(inputs: InputWithBand[]): VoteWeights {
  const totals: VoteWeights = { green: 0, yellow: 0, red: 0 };
  for (const input of inputs) {
    const weight = COMPASS_INPUT_WEIGHTS[input.inputCode];
    if (weight === undefined) {
      throw new Error(`Unknown input code: ${input.inputCode}`);
    }
    if (input.colorBand === 'GREEN') totals.green += weight;
    else if (input.colorBand === 'YELLOW') totals.yellow += weight;
    else if (input.colorBand === 'RED') totals.red += weight;
  }
  return totals;
}

export interface CrisisCheckInput {
  vixFiveDayAvg: number | null;
  hyOasLevel: number | null;
}

export interface CrisisCheckResult {
  fired: boolean;
  vixFiveDayAvg: number | null;
  hyOasLevel: number | null;
}

/**
 * Crisis override: VIX 5d avg > 30 AND HY OAS level > 7.0 (percent units).
 * Returns fired=false if either value is null (insufficient data).
 */
export function checkCrisisOverride(input: CrisisCheckInput): CrisisCheckResult {
  if (input.vixFiveDayAvg === null || input.hyOasLevel === null) {
    return {
      fired: false,
      vixFiveDayAvg: input.vixFiveDayAvg,
      hyOasLevel: input.hyOasLevel,
    };
  }
  const fired = input.vixFiveDayAvg > 30 && input.hyOasLevel > 7.0;
  return {
    fired,
    vixFiveDayAvg: input.vixFiveDayAvg,
    hyOasLevel: input.hyOasLevel,
  };
}

export interface CandidateInput {
  voteWeights: VoteWeights;
  crisisFired: boolean;
}

/**
 * Determine candidate regime from vote weights and crisis status.
 * Crisis override forces Risk-Off regardless of vote weights.
 */
export function determineCandidateRegime(input: CandidateInput): Regime {
  if (input.crisisFired) return 'Risk-Off';
  const { green, red } = input.voteWeights;
  if (red >= 4) return 'Risk-Off';
  if (green >= 5 && red <= 1) return 'Risk-On';
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
  crisisFired: boolean;
  prior: PriorClassification | null;
}

/**
 * Resolve today's active regime given today's candidate and the prior day's state.
 *
 * persistenceDaysCount counts the streak of candidates that diverge from the
 * current active regime. When it reaches 5, active flips and the counter resets.
 *
 * Rules:
 *   1. Crisis override → active=Risk-Off, count=0 (same-day, no streak required).
 *   2. Bootstrap (no prior) → active=Caution; count=0 if candidate matches Caution,
 *      else count=1 (day 1 of a streak toward the candidate).
 *   3. Normal:
 *      a. candidate == prior.activeRegime → count=0 (at active, no streak).
 *      b. candidate == prior.candidateRegime AND prior.count > 0 → continue streak.
 *         If new count >= 5 → flip active to candidate, count=0.
 *      c. otherwise → new streak with count=1, active unchanged.
 */
export function resolveActiveRegime(
  input: ResolveActiveRegimeInput,
): ActiveRegimeResolution {
  if (input.crisisFired) {
    return { activeRegime: 'Risk-Off', persistenceDaysCount: 0 };
  }

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

  if (
    input.candidateRegime === input.prior.candidateRegime &&
    input.prior.persistenceDaysCount > 0
  ) {
    const newCount = input.prior.persistenceDaysCount + 1;
    if (newCount >= 5) {
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

  return {
    activeRegime: input.prior.activeRegime,
    persistenceDaysCount: 1,
  };
}

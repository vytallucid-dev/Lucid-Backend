/**
 * Shock Layer (Phase 4) — Trigger A (Vol Shock) and Trigger B (Carry Shock).
 *
 * Pure logic, no I/O: this module only evaluates trigger conditions and
 * expiry/refresh mechanics against arrays the caller has already fetched, so
 * it is fully unit-testable and the DB-backed cache
 * (compass-shock-state.repository.ts) is provably recomputable by re-running
 * these evaluations over history — the same shape as
 * compass-curve-state-machine.ts (Phase 2B).
 *
 * "10 trading days" is measured as an observation-array-index difference
 * against the same series each trigger reads from (mirrors
 * isWithinRedWindow's convention) — no calendar-day/forward-fill logic.
 */

export interface ShockObservation {
  date: Date;
  value: number;
}

export interface TriggerAInput {
  /** SINGLE-DAY VIX close series (VIX_5D_AVG's stored rawValue), ascending. */
  vixCloses: ShockObservation[];
  /** HY OAS level series (percent units), ascending, same convention as HY_OAS's rawValue. */
  oasLevels: ShockObservation[];
  vixThreshold: number;
  oasDelta5Threshold: number;
}

export interface TriggerBInput {
  /** USDJPY daily close series, ascending. */
  usdJpyCloses: ShockObservation[];
  /** VIX 5-day average series (VIX_5D_AVG's stored derivedValue), ascending. */
  vix5dAvgs: ShockObservation[];
  usdJpyMove5Threshold: number;
}

export interface TriggerEvaluation {
  fired: boolean;
  asOfDate: Date;
}

function findByDate(series: ShockObservation[], date: Date): number | null {
  const value = series.find((o) => o.date.getTime() === date.getTime())?.value;
  return value ?? null;
}

function obsChangeAsOf(series: ShockObservation[], date: Date, n: number): number | null {
  const idx = series.findIndex((o) => o.date.getTime() === date.getTime());
  if (idx === -1 || idx - n < 0) return null;
  return series[idx].value - series[idx - n].value;
}

/**
 * Trigger A / Vol Shock:
 *   vix_close(t) > shock_a_vix_threshold
 *     AND (oas(t) - oas(t - 5 obs)) > shock_a_oas_delta5
 *
 * vix_close(t) is the SINGLE-DAY close (NOT the 5-day average). OAS delta is
 * over 5 observations, in FRED's native percent units (0.50 = 50bp) — never
 * converted to bp.
 */
export function evaluateTriggerA(asOfDate: Date, input: TriggerAInput): TriggerEvaluation {
  const vixClose = findByDate(input.vixCloses, asOfDate);
  const oasDelta5 = obsChangeAsOf(input.oasLevels, asOfDate, 5);

  if (vixClose === null || oasDelta5 === null) {
    return { fired: false, asOfDate };
  }

  const fired = vixClose > input.vixThreshold && oasDelta5 > input.oasDelta5Threshold;
  return { fired, asOfDate };
}

/**
 * Trigger B / Carry Shock:
 *   (usdjpy_close(t) / usdjpy_close(t - 5 obs) - 1) < shock_b_usdjpy_move5
 *     AND vix_5d_avg(t) > vix_5d_avg(t - 1)
 *
 * The USDJPY term is a SIGNED fall — strictly less than the (negative)
 * threshold. A rise of the same magnitude must NOT fire this.
 */
export function evaluateTriggerB(asOfDate: Date, input: TriggerBInput): TriggerEvaluation {
  const jpyIdx = input.usdJpyCloses.findIndex((o) => o.date.getTime() === asOfDate.getTime());
  if (jpyIdx === -1 || jpyIdx - 5 < 0) {
    return { fired: false, asOfDate };
  }
  const todayJpy = input.usdJpyCloses[jpyIdx].value;
  const jpy5ObsAgo = input.usdJpyCloses[jpyIdx - 5].value;
  if (jpy5ObsAgo === 0) {
    return { fired: false, asOfDate };
  }
  const move5 = todayJpy / jpy5ObsAgo - 1;

  const vixIdx = input.vix5dAvgs.findIndex((o) => o.date.getTime() === asOfDate.getTime());
  if (vixIdx === -1 || vixIdx - 1 < 0) {
    return { fired: false, asOfDate };
  }
  const vixToday = input.vix5dAvgs[vixIdx].value;
  const vixYesterday = input.vix5dAvgs[vixIdx - 1].value;

  const fired = move5 < input.usdJpyMove5Threshold && vixToday > vixYesterday;
  return { fired, asOfDate };
}

export interface ShockTriggerState {
  active: boolean;
  /** Last trading-day date (inclusive) the shock remains active, or null if never triggered. */
  expiry: Date | null;
}

/**
 * Advance one trigger's activation/expiry state by one day. Mirrors
 * activation/refresh/expiry mechanics identically for both triggers:
 *   - condition true on day t -> active from t, expiry = t + expiryTradingDays
 *     (measured via `series`' own index positions, inclusive of t).
 *   - condition true again later -> expiry RESETS to that day + N (does not
 *     stack — one expiry per trigger, always the most recent firing's).
 *   - once asOfDate is past expiry -> active=false.
 *
 * `series` must be the SAME series the trigger's own condition was evaluated
 * against (VIX closes for Trigger A, USDJPY closes for Trigger B), so trading
 * days are counted consistently with the rest of Compass's array-index
 * convention (mirrors compass-curve-state-machine.ts's isWithinRedWindow).
 */
export function advanceShockState(
  prior: ShockTriggerState | null,
  conditionFiredToday: boolean,
  asOfDate: Date,
  series: ShockObservation[],
  expiryTradingDays: number,
): ShockTriggerState {
  const asOfIndex = series.findIndex((o) => o.date.getTime() === asOfDate.getTime());

  if (conditionFiredToday) {
    if (asOfIndex === -1) {
      // Condition fired but we can't index today in the series (shouldn't
      // happen — the condition itself required today's index to exist).
      return { active: true, expiry: asOfDate };
    }
    const expiryIndex = asOfIndex + expiryTradingDays - 1;
    const expiryDate = expiryIndex < series.length ? series[expiryIndex].date : null;
    return { active: true, expiry: expiryDate ?? asOfDate };
  }

  if (prior === null || prior.expiry === null || !prior.active) {
    return { active: false, expiry: prior?.expiry ?? null };
  }

  if (asOfIndex === -1) {
    // Can't determine trading-day position of today — hold prior state.
    return prior;
  }

  const expiryIndex = series.findIndex((o) => o.date.getTime() === prior.expiry?.getTime());
  const stillActive = expiryIndex !== -1 && asOfIndex <= expiryIndex;

  return {
    active: stillActive,
    expiry: stillActive ? prior.expiry : null,
  };
}

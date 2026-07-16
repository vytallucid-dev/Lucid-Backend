/**
 * 2s10s (T10Y2Y) inversion episode state machine.
 *
 * An "episode" is a period where the curve is inverted for long enough to
 * matter (>= curve_inversion_min_obs consecutive observations < 0), and its
 * RED WINDOW is a fixed number of trading days starting from the day the
 * curve un-inverts (>= curve_uninversion_min_obs consecutive observations
 * >= 0). This module only scans a chronological series of {date, value}
 * observations and reports episode boundaries — it holds no state itself and
 * makes no I/O calls, so it is fully unit-testable and the DB-backed cache
 * (compass-curve-state.repository.ts) is provably recomputable by re-running
 * this scan over history.
 */

export interface CurveObservation {
  date: Date;
  value: number;
}

export interface CurveEpisode {
  /** First day of the >= curve_inversion_min_obs run where value < 0. */
  inversionStart: Date;
  /**
   * First day of the >= curve_uninversion_min_obs run where value >= 0,
   * i.e. the un-inversion date (NOT the day the confirmation run completes).
   * Null if the episode is still ongoing (curve has not yet un-inverted as
   * of the last observation in the scanned series).
   */
  unInversionDate: Date | null;
}

export interface CurveEpisodeScanResult {
  /** The most recent episode found in the scanned series, or null if none. */
  mostRecentEpisode: CurveEpisode | null;
}

/**
 * Scan a chronologically-ascending, gap-tolerant series of T10Y2Y
 * observations and return the most recent inversion episode (if any).
 *
 * Array-index based (no date-gap forward-fill, consistent with the rest of
 * Compass) — "N consecutive observations" means N consecutive elements of
 * the array as returned by FRED, not N consecutive calendar days.
 */
export function scanForMostRecentEpisode(
  observations: CurveObservation[],
  inversionMinObs: number,
  uninversionMinObs: number,
): CurveEpisodeScanResult {
  let mostRecentEpisode: CurveEpisode | null = null;
  let inversionRunStart: number | null = null; // index of first obs in the current < 0 run
  let currentEpisodeStart: Date | null = null; // set once an episode has begun
  let uninversionRunStart: number | null = null; // index of first obs in the current >= 0 run since episode began

  for (let i = 0; i < observations.length; i += 1) {
    const inverted = observations[i].value < 0;

    if (currentEpisodeStart === null) {
      // Not currently in a confirmed episode — track a potential inversion run.
      if (inverted) {
        if (inversionRunStart === null) inversionRunStart = i;
        if (i - inversionRunStart + 1 >= inversionMinObs) {
          currentEpisodeStart = observations[inversionRunStart].date;
          uninversionRunStart = null;
        }
      } else {
        inversionRunStart = null;
      }
      continue;
    }

    // Inside a confirmed episode — track a potential un-inversion run.
    if (!inverted) {
      if (uninversionRunStart === null) uninversionRunStart = i;
      if (i - uninversionRunStart + 1 >= uninversionMinObs) {
        mostRecentEpisode = {
          inversionStart: currentEpisodeStart,
          unInversionDate: observations[uninversionRunStart].date,
        };
        currentEpisodeStart = null;
        uninversionRunStart = null;
        inversionRunStart = null;
      }
    } else {
      uninversionRunStart = null;
    }
  }

  if (currentEpisodeStart !== null) {
    // Episode began within the scanned window but has not yet un-inverted.
    mostRecentEpisode = { inversionStart: currentEpisodeStart, unInversionDate: null };
  }

  return { mostRecentEpisode };
}

/**
 * Is `asOfDate` inside the RED WINDOW of `unInversionDate`? The window is
 * `redWindowTradingDays` TRADING DAYS starting from unInversionDate,
 * inclusive — measured as an observation-index count against `observations`
 * (the same series the episode was scanned from), not calendar days, so
 * weekends/holidays already absent from the FRED series don't inflate it.
 */
export function isWithinRedWindow(
  observations: CurveObservation[],
  unInversionDate: Date,
  asOfDate: Date,
  redWindowTradingDays: number,
): boolean {
  const unInversionIndex = observations.findIndex(
    (o) => o.date.getTime() === unInversionDate.getTime(),
  );
  const asOfIndex = observations.findIndex((o) => o.date.getTime() === asOfDate.getTime());
  if (unInversionIndex === -1 || asOfIndex === -1) return false;
  if (asOfIndex < unInversionIndex) return false;
  return asOfIndex - unInversionIndex + 1 <= redWindowTradingDays;
}

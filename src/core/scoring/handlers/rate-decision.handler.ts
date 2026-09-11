import { ScoringContext, ScoringResult, Score } from '../types';
import { findLatestRelease } from '../helpers/latest-release';

/**
 * Change 2 (rate decision scores surprise, not action). The engine scores
 * surprise versus forecast, never absolute level — the forecast already
 * prices in everything the market knows. Scoring the absolute action meant
 * an entirely expected hike scored +1 and sat there for six weeks despite
 * changing nothing anyone didn't already know. That is unchanged.
 *
 * What changed is the unit. `dp.value` and `dp.forecastValue` are now the
 * announced and expected rate LEVELS, in percentage points, the same as every
 * other indicator in the system stores. They used to be bps changes against
 * the prior decision, which cost a great deal and bought nothing here, because
 * the shared baseline cancels out of the subtraction:
 *
 *     (actual - prior) - (forecast - prior)  ==  actual - forecast
 *
 * The surprise this handler computes is therefore identical; only its unit
 * moved from basis points to percentage points, and the tolerance moved with
 * it. See rate-decision.helpers.ts for the full reasoning and what the old
 * shape broke.
 *
 * Target:
 *   More hawkish than expected (actual bps > forecast bps):  +1
 *   As expected (within tolerance):                           0
 *   More dovish than expected (actual bps < forecast bps):   -1
 *
 * No expectation on file (forecastValue null — true for every rate
 * DataPoint that predates Change 2, and for any future first-release print
 * entered without a forecast) → insufficient_data, never a fabricated
 * expectation and never the old absolute-action score. The engine's
 * carry-forward wrapper (scoreIndicator in engine.ts) is what supplies
 * between-meeting stickiness generically; this handler doesn't implement it
 * itself — it just returns the current print's score (or insufficient_data)
 * every time it's asked, same as before.
 */
export async function rateDecisionHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const dp = await findLatestRelease(ctx.indicatorId, ctx.observationDate);

  if (!dp) {
    return {
      kind: 'insufficient_data',
      reason: 'No rate decision on file',
      details: { indicatorCode: ctx.indicatorCode },
    };
  }

  const actualLevel = Number(dp.value);
  const forecastLevel = dp.forecastValue === null ? null : Number(dp.forecastValue);
  const priorLevel = dp.previousValue === null ? null : Number(dp.previousValue);

  // decision is the absolute action — retained for display/metadata only.
  // It no longer drives the score (that's exactly the defect being fixed).
  //
  // Null on a first release. The old shape reported HOLD there, because it had
  // hardcoded the bps change to 0 when there was no prior rate to diff against
  // — so "we don't know what this moved from" and "it didn't move" were the
  // same value. They are different facts and are now reported as such.
  let decision: 'HIKE' | 'CUT' | 'HOLD' | null;
  if (priorLevel === null) decision = null;
  else if (actualLevel > priorLevel) decision = 'HIKE';
  else if (actualLevel < priorLevel) decision = 'CUT';
  else decision = 'HOLD';

  if (forecastLevel === null) {
    return {
      kind: 'insufficient_data',
      reason: 'No expected rate on file for this decision — cannot score surprise',
      details: {
        indicatorCode: ctx.indicatorCode,
        dataPointId: dp.id,
        rate_level: actualLevel,
        prior_rate_level: priorLevel,
        decision,
      },
    };
  }

  // Tolerance in percentage points, exactly equivalent to the 0.01bp this used
  // while the columns held basis points: 0.01bp == 0.0001pp. Both values are
  // stored as entered and rounded to Decimal(20,6), so the only noise possible
  // is sub-1e-9 float error — the tolerance sits generously above that floor
  // while staying far below the smallest real central-bank increment (0.01pp),
  // so no genuine surprise is swallowed.
  const tolerance = 0.0001;
  const surprise = Math.round((actualLevel - forecastLevel) * 1e6) / 1e6;
  const tol = Math.round(tolerance * 1e6) / 1e6;

  let score: Score;
  let surpriseDirection: 'HAWKISH' | 'AS_EXPECTED' | 'DOVISH';
  if (surprise > tol) {
    score = 1;
    surpriseDirection = 'HAWKISH';
  } else if (surprise < -tol) {
    score = -1;
    surpriseDirection = 'DOVISH';
  } else {
    score = 0;
    surpriseDirection = 'AS_EXPECTED';
  }

  return {
    kind: 'scored',
    score,
    flags: [],
    metadata: {
      rate_level: actualLevel,
      expected_rate_level: forecastLevel,
      prior_rate_level: priorLevel,
      // Reported in bps as well as pp: a 25bp move is how a rate surprise is
      // spoken about, and this metadata is read by humans.
      surprise_pp: surprise,
      surprise_bps: Math.round(surprise * 100 * 1e6) / 1e6,
      tolerance,
      decision,
      surprise_direction: surpriseDirection,
      decision_date: dp.observationDate.toISOString().slice(0, 10),
      dataPointId: dp.id,
    },
  };
}

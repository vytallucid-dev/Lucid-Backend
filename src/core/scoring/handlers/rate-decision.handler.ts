import { ScoringContext, ScoringResult, Score } from '../types';
import { findLatestRelease } from '../helpers/latest-release';

/**
 * Change 2 (rate decision scores surprise, not action). The engine scores
 * surprise versus forecast, never absolute level — the forecast already
 * prices in everything the market knows. Scoring the absolute action meant
 * an entirely expected hike scored +1 and sat there for six weeks despite
 * changing nothing anyone didn't already know.
 *
 * Both `dp.value` and `dp.forecastValue` are bps change versus the prior
 * decision, in the SAME unit — see rate-decision.helpers.ts /
 * manual-data-entry.service.ts / forex-factory-indicator.service.ts, which
 * all convert an entered/published absolute rate level into a bps delta
 * against the same prior-rate baseline before storing either column. Diffing
 * them directly (no unit conversion here) is what keeps this comparison
 * honest — see recon note on why storing them in different units would be
 * the likely way this silently breaks.
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

  const actualBps = Number(dp.value);
  const forecastBps = dp.forecastValue === null ? null : Number(dp.forecastValue);

  // decision is the absolute action — retained for display/metadata only.
  // It no longer drives the score (that's exactly the defect being fixed).
  let decision: 'HIKE' | 'CUT' | 'HOLD';
  if (actualBps > 0) decision = 'HIKE';
  else if (actualBps < 0) decision = 'CUT';
  else decision = 'HOLD';

  if (forecastBps === null) {
    return {
      kind: 'insufficient_data',
      reason: 'No expected rate on file for this decision — cannot score surprise',
      details: {
        indicatorCode: ctx.indicatorCode,
        dataPointId: dp.id,
        bps_change: actualBps,
        decision,
      },
    };
  }

  // Tolerance in bps. Both values are computed as (level - priorLevel) * 100
  // in floating point before being rounded to Decimal(20,6) on write, so the
  // only "noise" possible here is sub-1e-9-bp float error — 0.01bp is
  // generously above that floor while staying far below the smallest real
  // central-bank increment (1bp), so no genuine surprise gets swallowed.
  const tolerance = 0.01;
  const surprise = Math.round((actualBps - forecastBps) * 1e6) / 1e6;
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
      bps_change: actualBps,
      forecast_bps_change: forecastBps,
      surprise_bps: surprise,
      tolerance,
      decision,
      surprise_direction: surpriseDirection,
      decision_date: dp.observationDate.toISOString().slice(0, 10),
      dataPointId: dp.id,
    },
  };
}

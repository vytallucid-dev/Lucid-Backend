import { AutoAnchors, ScorecardHistoryRow, VelocityLabel, VelocityResult } from './types';
import { countTradingDaysBetween } from '@core/utils/trading-calendar';

const AUTO_ANCHOR_LOOKBACK_SESSIONS = 120;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Sessions = NSE trading days strictly after startDate, up to and including
 * endDate, per the nse_holidays calendar (src/core/utils/trading-calendar.ts).
 *
 * Changed 2026-08-17 — this previously counted entries in the `history`
 * array (i.e. scorecard rows that happened to exist), which double-counted
 * weekends before scorecard generation was gated to trading days only (see
 * B2 of the same phase). A stale `history` array is no longer even needed
 * here; kept as an unused param removed entirely rather than left dangling.
 */
async function sessionsBetween(startDate: Date, endDate: Date): Promise<number> {
  return countTradingDaysBetween(startDate, endDate);
}

export function classifyVelocity(velocity: number): VelocityLabel {
  if (velocity <= -1.0) return 'Emergency Deterioration';
  if (velocity <= -0.5) return 'Warning';
  if (velocity <= -0.3) return 'Alert';
  if (velocity <= -0.1) return 'Mild Deterioration';
  if (velocity < 0.1) return 'Flat';
  if (velocity < 0.3) return 'Slow Repair';
  if (velocity < 0.75) return 'Fast Repair';
  return 'Ceiling Recovery';
}

/**
 * Find default auto-anchors per v2.0 spec Section 3.1.
 *
 * High anchor: Net >= +10 (single reading), OR Net = +9 if it is the highest in trailing 120 sessions.
 * Low anchor: Net <= 0 (single reading), most recent in trailing 120 sessions.
 *
 * Default start = whichever is more recent (high or low). If neither exists, null.
 *
 * @param currentScorecard the scorecard being assembled (today's row, the "end")
 * @param history all scorecards strictly BEFORE currentScorecard, ordered DESC by observation_date
 */
export function computeAutoAnchors(
  currentScorecard: ScorecardHistoryRow,
  history: ScorecardHistoryRow[],
): AutoAnchors {
  void currentScorecard;
  const window = history.slice(0, AUTO_ANCHOR_LOOKBACK_SESSIONS);

  let highAnchor: ScorecardHistoryRow | null = null;
  const plus10Candidate = window.find((r) => r.netScore >= 10);
  if (plus10Candidate) {
    highAnchor = plus10Candidate;
  } else {
    const plus9Candidates = window.filter((r) => r.netScore === 9);
    if (plus9Candidates.length > 0) {
      const maxNetInWindow = Math.max(...window.map((r) => r.netScore));
      if (maxNetInWindow === 9) {
        highAnchor = plus9Candidates[0];
      }
    }
  }

  const lowAnchor = window.find((r) => r.netScore <= 0) ?? null;

  let defaultStart: ScorecardHistoryRow | null = null;
  if (highAnchor && lowAnchor) {
    defaultStart =
      highAnchor.observationDate >= lowAnchor.observationDate ? highAnchor : lowAnchor;
  } else {
    defaultStart = highAnchor ?? lowAnchor;
  }

  return {
    highAnchorDate: highAnchor ? toIsoDate(highAnchor.observationDate) : null,
    highAnchorNet: highAnchor?.netScore ?? null,
    lowAnchorDate: lowAnchor ? toIsoDate(lowAnchor.observationDate) : null,
    lowAnchorNet: lowAnchor?.netScore ?? null,
    defaultStartDate: defaultStart ? toIsoDate(defaultStart.observationDate) : null,
    defaultStartNet: defaultStart?.netScore ?? null,
  };
}

/**
 * Compute velocity between two anchor points.
 *
 * @param startScorecard the start anchor row (or null if not found)
 * @param endScorecard the end anchor row (typically today's scorecard)
 * @param history full scorecard history — no longer used for the session
 *   count (see sessionsBetween), kept in the signature because
 *   computeAutoAnchors's caller passes the same `history` around and callers
 *   still call both together; retained for call-site stability.
 */
export async function computeVelocity(
  startScorecard: ScorecardHistoryRow | null,
  endScorecard: ScorecardHistoryRow,
  history: ScorecardHistoryRow[],
): Promise<VelocityResult> {
  void history;
  if (!startScorecard) {
    return {
      velocity: null,
      label: null,
      sessions: null,
      startDate: null,
      endDate: toIsoDate(endScorecard.observationDate),
      startNet: null,
      endNet: endScorecard.netScore,
      reason: 'No qualifying anchor found in trailing 120 sessions',
    };
  }

  const sessions = await sessionsBetween(
    startScorecard.observationDate,
    endScorecard.observationDate,
  );

  if (sessions <= 0) {
    return {
      velocity: null,
      label: null,
      sessions: 0,
      startDate: toIsoDate(startScorecard.observationDate),
      endDate: toIsoDate(endScorecard.observationDate),
      startNet: startScorecard.netScore,
      endNet: endScorecard.netScore,
      reason: 'Start and end are the same scorecard',
    };
  }

  const velocity = (endScorecard.netScore - startScorecard.netScore) / sessions;
  const label = classifyVelocity(velocity);

  return {
    velocity,
    label,
    sessions,
    startDate: toIsoDate(startScorecard.observationDate),
    endDate: toIsoDate(endScorecard.observationDate),
    startNet: startScorecard.netScore,
    endNet: endScorecard.netScore,
  };
}

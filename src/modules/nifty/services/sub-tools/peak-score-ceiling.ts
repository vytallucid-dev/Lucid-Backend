import { DecayTier, EntryReason, PeakScoreCeilingState, ScorecardHistoryRow } from './types';

const LOOKBACK_SESSIONS_FOR_120D_HIGH = 120;
const DEACTIVATION_CONSECUTIVE_THRESHOLD = 5;
const PLUS_10_THRESHOLD = 10;
const PLUS_9_THRESHOLD = 9;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parsePriorState(value: unknown): PeakScoreCeilingState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.status === 'inactive') return { status: 'inactive' };
  if (v.status === 'active') {
    return value as PeakScoreCeilingState;
  }
  return null;
}

function classifyDecay(decayPerDay: number): DecayTier {
  if (decayPerDay > -0.2) return 'PASSIVE';
  if (decayPerDay > -0.5) return 'ACTIVE';
  return 'SHARP';
}

function sessionsBetween(
  history: ScorecardHistoryRow[],
  startDate: Date,
  endDate: Date,
): number {
  let count = 0;
  for (const row of history) {
    if (row.observationDate > startDate && row.observationDate <= endDate) {
      count++;
    }
  }
  return count;
}

/**
 * Determine if the current scorecard qualifies for peak-score entry.
 *
 * Entry conditions per spec Section 3.2:
 *   - Net >= +10 (fires unconditionally), OR
 *   - Net = +9 AND is the highest Net in trailing 120 sessions
 *
 * @param history all scorecards strictly BEFORE currentScorecard, ordered DESC by observation_date
 */
function qualifiesForEntry(
  currentScorecard: ScorecardHistoryRow,
  history: ScorecardHistoryRow[],
): { qualifies: boolean; reason: EntryReason | null } {
  if (currentScorecard.netScore >= PLUS_10_THRESHOLD) {
    return { qualifies: true, reason: 'plus_10' };
  }
  if (currentScorecard.netScore === PLUS_9_THRESHOLD) {
    const window = history.slice(0, LOOKBACK_SESSIONS_FOR_120D_HIGH);
    const maxPriorNet =
      window.length > 0 ? Math.max(...window.map((r) => r.netScore)) : -Infinity;
    if (maxPriorNet <= PLUS_9_THRESHOLD) {
      return { qualifies: true, reason: 'plus_9_120d_high' };
    }
  }
  return { qualifies: false, reason: null };
}

function thresholdForState(state: { entryReason: EntryReason }): number {
  return state.entryReason === 'plus_10' ? PLUS_10_THRESHOLD : PLUS_9_THRESHOLD;
}

/**
 * Compute peak-score ceiling state for a new scorecard given the prior scorecard's state.
 *
 * State machine per spec Section 3.2:
 *   - inactive → active when current qualifies for entry
 *   - active → continues; recompute decay
 *   - active → pendingDeactivation when Net falls below threshold
 *   - pendingDeactivation → inactive after 5 consecutive sessions outside threshold
 *   - active OR pendingDeactivation → restart active if current re-qualifies (resets peak)
 *
 * @param currentScorecard the row being assembled
 * @param history all scorecards before currentScorecard, ordered DESC by observation_date
 * @param priorState prior scorecard's peak_score_ceiling_state value (null if no prior)
 */
export function computePeakScoreState(
  currentScorecard: ScorecardHistoryRow,
  history: ScorecardHistoryRow[],
  priorState: unknown,
): PeakScoreCeilingState {
  const parsedPrior = parsePriorState(priorState);
  const entryCheck = qualifiesForEntry(currentScorecard, history);

  // CASE A: No prior state or prior inactive → check entry
  if (!parsedPrior || parsedPrior.status === 'inactive') {
    if (!entryCheck.qualifies || entryCheck.reason === null) {
      return { status: 'inactive' };
    }
    return {
      status: 'active',
      peakDate: toIsoDate(currentScorecard.observationDate),
      peakNetScore: currentScorecard.netScore,
      entryReason: entryCheck.reason,
      sessionsSincePeak: 0,
      currentNetScore: currentScorecard.netScore,
      decayPerDay: 0,
      decayTier: 'PASSIVE',
      pendingDeactivation: false,
      sessionsBelowThreshold: 0,
    };
  }

  // CASE B: Prior active → evaluate continuation, deactivation, or re-entry
  const prior = parsedPrior;

  // Sub-case B1: Current scorecard re-qualifies → reset or continue with new peak if higher
  if (entryCheck.qualifies && entryCheck.reason !== null) {
    if (currentScorecard.netScore > prior.peakNetScore) {
      return {
        status: 'active',
        peakDate: toIsoDate(currentScorecard.observationDate),
        peakNetScore: currentScorecard.netScore,
        entryReason: entryCheck.reason,
        sessionsSincePeak: 0,
        currentNetScore: currentScorecard.netScore,
        decayPerDay: 0,
        decayTier: 'PASSIVE',
        pendingDeactivation: false,
        sessionsBelowThreshold: 0,
      };
    }
    const peakDateObj = new Date(prior.peakDate + 'T00:00:00.000Z');
    const sessions = sessionsBetween(
      history.concat([currentScorecard]),
      peakDateObj,
      currentScorecard.observationDate,
    );
    const decayPerDay =
      sessions > 0 ? (currentScorecard.netScore - prior.peakNetScore) / sessions : 0;
    return {
      status: 'active',
      peakDate: prior.peakDate,
      peakNetScore: prior.peakNetScore,
      entryReason: prior.entryReason,
      sessionsSincePeak: sessions,
      currentNetScore: currentScorecard.netScore,
      decayPerDay,
      decayTier: classifyDecay(decayPerDay),
      pendingDeactivation: false,
      sessionsBelowThreshold: 0,
    };
  }

  // Sub-case B2: Net dropped below threshold → start or continue pending deactivation
  const threshold = thresholdForState(prior);
  if (currentScorecard.netScore < threshold) {
    const sessionsBelow = prior.pendingDeactivation ? prior.sessionsBelowThreshold + 1 : 1;
    if (sessionsBelow >= DEACTIVATION_CONSECUTIVE_THRESHOLD) {
      return { status: 'inactive' };
    }
    const peakDateObj = new Date(prior.peakDate + 'T00:00:00.000Z');
    const sessions = sessionsBetween(
      history.concat([currentScorecard]),
      peakDateObj,
      currentScorecard.observationDate,
    );
    const decayPerDay =
      sessions > 0 ? (currentScorecard.netScore - prior.peakNetScore) / sessions : 0;
    return {
      status: 'active',
      peakDate: prior.peakDate,
      peakNetScore: prior.peakNetScore,
      entryReason: prior.entryReason,
      sessionsSincePeak: sessions,
      currentNetScore: currentScorecard.netScore,
      decayPerDay,
      decayTier: classifyDecay(decayPerDay),
      pendingDeactivation: true,
      sessionsBelowThreshold: sessionsBelow,
    };
  }

  // Sub-case B3: Net still >= threshold, no re-qualification → continue tracking
  const peakDateObj = new Date(prior.peakDate + 'T00:00:00.000Z');
  const sessions = sessionsBetween(
    history.concat([currentScorecard]),
    peakDateObj,
    currentScorecard.observationDate,
  );
  const decayPerDay =
    sessions > 0 ? (currentScorecard.netScore - prior.peakNetScore) / sessions : 0;
  return {
    status: 'active',
    peakDate: prior.peakDate,
    peakNetScore: prior.peakNetScore,
    entryReason: prior.entryReason,
    sessionsSincePeak: sessions,
    currentNetScore: currentScorecard.netScore,
    decayPerDay,
    decayTier: classifyDecay(decayPerDay),
    pendingDeactivation: false,
    sessionsBelowThreshold: 0,
  };
}

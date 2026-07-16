import { describe, it, expect } from 'vitest';
import {
  sumVoteWeights,
  determineCandidateRegime,
  resolveActiveRegime,
  type InputWithBand,
  type PriorClassification,
  type Regime,
} from '@modules/edgefinder/services/compass/compass-classifier-logic';
import { COMPASS_CONFIG_V1_FIXTURE as cfg } from './compass-config.fixture';

const ALL_INPUT_CODES = [
  'VIX_5D_AVG',
  'HY_OAS',
  'YIELD_2S10S',
  'DXY_TREND',
  'VIX_TERM_STRUCTURE',
  'US_DATA_STACK',
] as const;

describe('config.weights', () => {
  it('has the 6 expected codes summing to 8.0', () => {
    expect(Object.keys(cfg.weights).sort()).toEqual(
      [...ALL_INPUT_CODES].sort(),
    );
    const total = Object.values(cfg.weights).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(8.0, 10);
  });
});

describe('sumVoteWeights', () => {
  it('returns all-zero for empty input', () => {
    expect(sumVoteWeights([], cfg)).toEqual({ green: 0, yellow: 0, red: 0 });
  });

  it('sums all 6 GREEN → green=8, yellow=0, red=0', () => {
    const inputs: InputWithBand[] = ALL_INPUT_CODES.map((c) => ({
      inputCode: c,
      colorBand: 'GREEN' as const,
    }));
    expect(sumVoteWeights(inputs, cfg)).toEqual({ green: 8, yellow: 0, red: 0 });
  });

  it('sums all 6 RED → red=8, green=0, yellow=0', () => {
    const inputs: InputWithBand[] = ALL_INPUT_CODES.map((c) => ({
      inputCode: c,
      colorBand: 'RED' as const,
    }));
    expect(sumVoteWeights(inputs, cfg)).toEqual({ green: 0, yellow: 0, red: 8 });
  });

  it('sums all 6 YELLOW → yellow=8', () => {
    const inputs: InputWithBand[] = ALL_INPUT_CODES.map((c) => ({
      inputCode: c,
      colorBand: 'YELLOW' as const,
    }));
    expect(sumVoteWeights(inputs, cfg)).toEqual({ green: 0, yellow: 8, red: 0 });
  });

  it('sums mixed bands by code-weight', () => {
    const inputs: InputWithBand[] = [
      { inputCode: 'VIX_5D_AVG', colorBand: 'GREEN' },
      { inputCode: 'HY_OAS', colorBand: 'GREEN' },
      { inputCode: 'YIELD_2S10S', colorBand: 'YELLOW' },
      { inputCode: 'DXY_TREND', colorBand: 'YELLOW' },
      { inputCode: 'VIX_TERM_STRUCTURE', colorBand: 'YELLOW' },
      { inputCode: 'US_DATA_STACK', colorBand: 'RED' },
    ];
    const result = sumVoteWeights(inputs, cfg);
    // VIX_5D_AVG(1.0)+HY_OAS(1.5)=2.5 green; YIELD_2S10S(1.0)+DXY_TREND(1.0)+VIX_TERM_STRUCTURE(1.5)=3.5 yellow; US_DATA_STACK(2.0) red
    expect(result.green).toBeCloseTo(2.5, 10);
    expect(result.yellow).toBeCloseTo(3.5, 10);
    expect(result.red).toBeCloseTo(2.0, 10);
  });

  it('throws on unknown input code', () => {
    expect(() =>
      sumVoteWeights([{ inputCode: 'BOGUS', colorBand: 'GREEN' }], cfg),
    ).toThrow(/Unknown input code: BOGUS/);
  });
});

describe('determineCandidateRegime', () => {
  it('returns Risk-On at exact green=5 AND red=1 boundary', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 5, yellow: 2, red: 1 },
      }, cfg),
    ).toBe('Risk-On');
  });

  it('returns Risk-On with green=8 red=0', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 8, yellow: 0, red: 0 },
      }, cfg),
    ).toBe('Risk-On');
  });

  it('returns Caution when green=4.9 (just below threshold)', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 4.9, yellow: 2.1, red: 1 },
      }, cfg),
    ).toBe('Caution');
  });

  it('returns Caution when red=1.5 (above red-cap, below 3.5)', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 5, yellow: 1.5, red: 1.5 },
      }, cfg),
    ).toBe('Caution');
  });

  it('returns Risk-Off at exact red=3.5 boundary (v2 threshold)', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 0, yellow: 4.5, red: 3.5 },
      }, cfg),
    ).toBe('Risk-Off');
  });

  it('returns Caution when red=3.4 (just below Risk-Off)', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 0, yellow: 4.6, red: 3.4 },
      }, cfg),
    ).toBe('Caution');
  });

  it('returns Risk-Off when red >= 3.5 wins over Risk-On gate', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 5, yellow: 0, red: 3.5 },
      }, cfg),
    ).toBe('Risk-Off');
  });

  it('returns Caution for balanced mid-range', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 3, yellow: 3, red: 2 },
      }, cfg),
    ).toBe('Caution');
  });
});

function prior(
  active: Regime,
  candidate: Regime,
  count: number,
): PriorClassification {
  return {
    activeRegime: active,
    candidateRegime: candidate,
    persistenceDaysCount: count,
  };
}

describe('resolveActiveRegime — v2 asymmetric persistence machine (Phase 4: crisis-clause-free, shock-unaware)', () => {
  it('bootstrap + Caution candidate → active=Caution, count=0', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Caution',
        prior: null,
      }, cfg),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 0 });
  });

  it('bootstrap + Risk-Off candidate → active=Caution, count=1 (day 1 of pending streak)', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-Off',
        prior: null,
      }, cfg),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 1 });
  });

  it('bootstrap + Risk-On candidate → active=Caution, count=1', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-On',
        prior: null,
      }, cfg),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 1 });
  });

  it('candidate == active → pending cleared to count=0 even if mid-streak', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Caution',
        prior: prior('Caution', 'Risk-Off', 2),
      }, cfg),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 0 });
  });

  it('[case 1] Caution → Risk-Off: confirms on day 3, not day 2', () => {
    // Day 1: active=Caution, raw=Risk-Off → pending=Risk-Off count=1 (required=3, higher severity)
    const day1 = resolveActiveRegime(
      { candidateRegime: 'Risk-Off', prior: prior('Caution', 'Caution', 0) },
      cfg,
    );
    expect(day1).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 1 });

    // Day 2: still Risk-Off → count=2, still short of required=3 → NOT confirmed yet
    const day2 = resolveActiveRegime(
      { candidateRegime: 'Risk-Off', prior: prior('Caution', 'Risk-Off', 1) },
      cfg,
    );
    expect(day2).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 2 });

    // Day 3: still Risk-Off → count=3 >= required=3 → CONFIRMED, active flips
    const day3 = resolveActiveRegime(
      { candidateRegime: 'Risk-Off', prior: prior('Caution', 'Risk-Off', 2) },
      cfg,
    );
    expect(day3).toEqual({ activeRegime: 'Risk-Off', persistenceDaysCount: 0 });
  });

  it('[case 2] Risk-Off → Caution: confirms on day 5, not day 4', () => {
    // Days 1-4: active=Risk-Off, raw=Caution (lower severity, required=5)
    const day4 = resolveActiveRegime(
      { candidateRegime: 'Caution', prior: prior('Risk-Off', 'Caution', 3) },
      cfg,
    );
    expect(day4).toEqual({ activeRegime: 'Risk-Off', persistenceDaysCount: 4 }); // day 4, NOT confirmed

    // Day 5: count=5 >= required=5 → CONFIRMED
    const day5 = resolveActiveRegime(
      { candidateRegime: 'Caution', prior: prior('Risk-Off', 'Caution', 4) },
      cfg,
    );
    expect(day5).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 0 });
  });

  it('[case 3] Risk-On → Risk-Off (multi-step, higher severity): confirms on day 3, transitions DIRECTLY, never through Caution', () => {
    // active=Risk-On throughout; raw=Risk-Off is 2 severity steps away but still a SINGLE transition
    const day1 = resolveActiveRegime(
      { candidateRegime: 'Risk-Off', prior: prior('Risk-On', 'Risk-On', 0) },
      cfg,
    );
    expect(day1).toEqual({ activeRegime: 'Risk-On', persistenceDaysCount: 1 });

    const day2 = resolveActiveRegime(
      { candidateRegime: 'Risk-Off', prior: prior('Risk-On', 'Risk-Off', 1) },
      cfg,
    );
    expect(day2).toEqual({ activeRegime: 'Risk-On', persistenceDaysCount: 2 });

    const day3 = resolveActiveRegime(
      { candidateRegime: 'Risk-Off', prior: prior('Risk-On', 'Risk-Off', 2) },
      cfg,
    );
    // Confirmed in 3 days (severity(Risk-Off)=2 > severity(Risk-On)=0 → higher → required=3)
    // and active goes DIRECTLY to Risk-Off — the resolution never sets activeRegime=Caution
    // at any point in this trace.
    expect(day3).toEqual({ activeRegime: 'Risk-Off', persistenceDaysCount: 0 });
  });

  it('[case 4] Risk-Off → Risk-On (multi-step, lower severity): confirms on day 5', () => {
    const day4 = resolveActiveRegime(
      { candidateRegime: 'Risk-On', prior: prior('Risk-Off', 'Risk-On', 3) },
      cfg,
    );
    expect(day4).toEqual({ activeRegime: 'Risk-Off', persistenceDaysCount: 4 }); // not yet

    const day5 = resolveActiveRegime(
      { candidateRegime: 'Risk-On', prior: prior('Risk-Off', 'Risk-On', 4) },
      cfg,
    );
    expect(day5).toEqual({ activeRegime: 'Risk-On', persistenceDaysCount: 0 });
  });

  it('[case 5] streak break: 2 days pending Risk-Off, then 1 day Caution → pending cleared (raw == active)', () => {
    const result = resolveActiveRegime(
      { candidateRegime: 'Caution', prior: prior('Caution', 'Risk-Off', 2) },
      cfg,
    );
    expect(result).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 0 });
  });

  it('[case 5b] streak break to a non-active label: 2 days pending Risk-Off, then 1 day Risk-On → pending resets to Risk-On, count=1', () => {
    const result = resolveActiveRegime(
      { candidateRegime: 'Risk-On', prior: prior('Caution', 'Risk-Off', 2) },
      cfg,
    );
    // raw(Risk-On) != active(Caution) and != prior pending(Risk-Off) → RESET: new pending
    // streak toward Risk-On, count=1 (not 0, not 3).
    expect(result).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 1 });
  });

  it('[case 6] return to active: pending Risk-Off for 2 days, then raw == active → pending cleared, count=0', () => {
    const result = resolveActiveRegime(
      { candidateRegime: 'Caution', prior: prior('Caution', 'Risk-Off', 2) },
      cfg,
    );
    expect(result).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 0 });
  });

  it('[case 11] the machine keeps running and stays current even where a shock would otherwise be active — this function has no shock parameter at all, so it cannot be short-circuited by one', () => {
    // Simulate several days of persistence evolution that would occur "under"
    // an active shock (Trigger A does not touch this function's inputs/outputs).
    const day1 = resolveActiveRegime(
      { candidateRegime: 'Risk-Off', prior: prior('Caution', 'Caution', 0) },
      cfg,
    );
    const day2 = resolveActiveRegime(
      { candidateRegime: 'Risk-Off', prior: { activeRegime: day1.activeRegime, candidateRegime: 'Risk-Off', persistenceDaysCount: day1.persistenceDaysCount } },
      cfg,
    );
    const day3 = resolveActiveRegime(
      { candidateRegime: 'Risk-Off', prior: { activeRegime: day2.activeRegime, candidateRegime: 'Risk-Off', persistenceDaysCount: day2.persistenceDaysCount } },
      cfg,
    );
    // By day 3 the standard machine has confirmed Risk-Off on its own — this
    // is the state final_regime would reveal once a shock (irrelevant to this
    // function) expires.
    expect(day3).toEqual({ activeRegime: 'Risk-Off', persistenceDaysCount: 0 });
  });

  it('required is computed fresh each day from pending_label vs CURRENT active_regime, not the original candidate', () => {
    const result = resolveActiveRegime(
      { candidateRegime: 'Caution', prior: prior('Risk-On', 'Caution', 2) },
      cfg,
    );
    expect(result).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 0 }); // count 2+1=3 >= required 3
  });
});

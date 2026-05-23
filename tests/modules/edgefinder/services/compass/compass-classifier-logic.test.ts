import { describe, it, expect } from 'vitest';
import {
  COMPASS_INPUT_WEIGHTS,
  sumVoteWeights,
  checkCrisisOverride,
  determineCandidateRegime,
  resolveActiveRegime,
  type InputWithBand,
  type PriorClassification,
  type Regime,
} from '@modules/edgefinder/services/compass/compass-classifier-logic';

const ALL_INPUT_CODES = [
  'VIX_5D_AVG',
  'HY_OAS',
  'YIELD_2S10S',
  'DXY_TREND',
  'GOLD_DXY_CORR',
  'US_DATA_STACK',
] as const;

describe('COMPASS_INPUT_WEIGHTS', () => {
  it('has the 6 expected codes summing to 8.0', () => {
    expect(Object.keys(COMPASS_INPUT_WEIGHTS).sort()).toEqual(
      [...ALL_INPUT_CODES].sort(),
    );
    const total = Object.values(COMPASS_INPUT_WEIGHTS).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(8.0, 10);
  });
});

describe('sumVoteWeights', () => {
  it('returns all-zero for empty input', () => {
    expect(sumVoteWeights([])).toEqual({ green: 0, yellow: 0, red: 0 });
  });

  it('sums all 6 GREEN → green=8, yellow=0, red=0', () => {
    const inputs: InputWithBand[] = ALL_INPUT_CODES.map((c) => ({
      inputCode: c,
      colorBand: 'GREEN' as const,
    }));
    expect(sumVoteWeights(inputs)).toEqual({ green: 8, yellow: 0, red: 0 });
  });

  it('sums all 6 RED → red=8, green=0, yellow=0', () => {
    const inputs: InputWithBand[] = ALL_INPUT_CODES.map((c) => ({
      inputCode: c,
      colorBand: 'RED' as const,
    }));
    expect(sumVoteWeights(inputs)).toEqual({ green: 0, yellow: 0, red: 8 });
  });

  it('sums all 6 YELLOW → yellow=8', () => {
    const inputs: InputWithBand[] = ALL_INPUT_CODES.map((c) => ({
      inputCode: c,
      colorBand: 'YELLOW' as const,
    }));
    expect(sumVoteWeights(inputs)).toEqual({ green: 0, yellow: 8, red: 0 });
  });

  it('sums mixed bands by code-weight', () => {
    const inputs: InputWithBand[] = [
      { inputCode: 'VIX_5D_AVG', colorBand: 'GREEN' },
      { inputCode: 'HY_OAS', colorBand: 'GREEN' },
      { inputCode: 'YIELD_2S10S', colorBand: 'YELLOW' },
      { inputCode: 'DXY_TREND', colorBand: 'YELLOW' },
      { inputCode: 'GOLD_DXY_CORR', colorBand: 'YELLOW' },
      { inputCode: 'US_DATA_STACK', colorBand: 'RED' },
    ];
    const result = sumVoteWeights(inputs);
    expect(result.green).toBeCloseTo(2.5, 10);
    expect(result.yellow).toBeCloseTo(3.5, 10);
    expect(result.red).toBeCloseTo(2.0, 10);
  });

  it('throws on unknown input code', () => {
    expect(() =>
      sumVoteWeights([{ inputCode: 'BOGUS', colorBand: 'GREEN' }]),
    ).toThrow(/Unknown input code: BOGUS/);
  });
});

describe('checkCrisisOverride', () => {
  it('fires when VIX > 30 AND HY > 7.0', () => {
    const result = checkCrisisOverride({ vixFiveDayAvg: 35, hyOasLevel: 7.5 });
    expect(result.fired).toBe(true);
    expect(result.vixFiveDayAvg).toBe(35);
    expect(result.hyOasLevel).toBe(7.5);
  });

  it('does not fire when HY exactly at 7.0 (strict >)', () => {
    expect(
      checkCrisisOverride({ vixFiveDayAvg: 35, hyOasLevel: 7.0 }).fired,
    ).toBe(false);
  });

  it('does not fire when VIX exactly at 30 (strict >)', () => {
    expect(
      checkCrisisOverride({ vixFiveDayAvg: 30, hyOasLevel: 8.0 }).fired,
    ).toBe(false);
  });

  it('does not fire when HY just below 7', () => {
    expect(
      checkCrisisOverride({ vixFiveDayAvg: 35, hyOasLevel: 6.9 }).fired,
    ).toBe(false);
  });

  it('does not fire when VIX just below 30', () => {
    expect(
      checkCrisisOverride({ vixFiveDayAvg: 29, hyOasLevel: 8.0 }).fired,
    ).toBe(false);
  });

  it('returns fired=false when VIX is null', () => {
    const result = checkCrisisOverride({ vixFiveDayAvg: null, hyOasLevel: 8 });
    expect(result.fired).toBe(false);
    expect(result.vixFiveDayAvg).toBeNull();
    expect(result.hyOasLevel).toBe(8);
  });

  it('returns fired=false when HY is null', () => {
    const result = checkCrisisOverride({ vixFiveDayAvg: 40, hyOasLevel: null });
    expect(result.fired).toBe(false);
  });

  it('returns fired=false when both are null', () => {
    expect(
      checkCrisisOverride({ vixFiveDayAvg: null, hyOasLevel: null }).fired,
    ).toBe(false);
  });
});

describe('determineCandidateRegime', () => {
  it('returns Risk-On at exact green=5 AND red=1 boundary', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 5, yellow: 2, red: 1 },
        crisisFired: false,
      }),
    ).toBe('Risk-On');
  });

  it('returns Risk-On with green=8 red=0', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 8, yellow: 0, red: 0 },
        crisisFired: false,
      }),
    ).toBe('Risk-On');
  });

  it('returns Caution when green=4.9 (just below threshold)', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 4.9, yellow: 2.1, red: 1 },
        crisisFired: false,
      }),
    ).toBe('Caution');
  });

  it('returns Caution when red=1.5 (above red-cap, below 4)', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 5, yellow: 1.5, red: 1.5 },
        crisisFired: false,
      }),
    ).toBe('Caution');
  });

  it('returns Risk-Off at exact red=4 boundary', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 0, yellow: 4, red: 4 },
        crisisFired: false,
      }),
    ).toBe('Risk-Off');
  });

  it('returns Caution when red=3.9 (just below Risk-Off)', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 0, yellow: 4.1, red: 3.9 },
        crisisFired: false,
      }),
    ).toBe('Caution');
  });

  it('returns Risk-Off when crisis fires regardless of weights (all green)', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 8, yellow: 0, red: 0 },
        crisisFired: true,
      }),
    ).toBe('Risk-Off');
  });

  it('returns Risk-Off when red >= 4 wins over Risk-On gate', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 5, yellow: 0, red: 4 },
        crisisFired: false,
      }),
    ).toBe('Risk-Off');
  });

  it('returns Caution for balanced mid-range', () => {
    expect(
      determineCandidateRegime({
        voteWeights: { green: 3, yellow: 3, red: 2 },
        crisisFired: false,
      }),
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

describe('resolveActiveRegime', () => {
  it('bootstrap + Caution candidate → active=Caution, count=0', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Caution',
        crisisFired: false,
        prior: null,
      }),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 0 });
  });

  it('bootstrap + Risk-Off candidate → active=Caution, count=1', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-Off',
        crisisFired: false,
        prior: null,
      }),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 1 });
  });

  it('bootstrap + Risk-On candidate → active=Caution, count=1', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-On',
        crisisFired: false,
        prior: null,
      }),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 1 });
  });

  it('crisis with no prior → active=Risk-Off, count=0', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-Off',
        crisisFired: true,
        prior: null,
      }),
    ).toEqual({ activeRegime: 'Risk-Off', persistenceDaysCount: 0 });
  });

  it('crisis with active=Caution prior → flips same-day to Risk-Off, count=0', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-Off',
        crisisFired: true,
        prior: prior('Caution', 'Caution', 0),
      }),
    ).toEqual({ activeRegime: 'Risk-Off', persistenceDaysCount: 0 });
  });

  it('candidate == active → count resets to 0 even if mid-streak', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Caution',
        crisisFired: false,
        prior: prior('Caution', 'Risk-Off', 3),
      }),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 0 });
  });

  it('continues streak: prior count=1 + same candidate → count=2', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-Off',
        crisisFired: false,
        prior: prior('Caution', 'Risk-Off', 1),
      }),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 2 });
  });

  it('continues streak: prior count=4 + same candidate → flips, count=0', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-Off',
        crisisFired: false,
        prior: prior('Caution', 'Risk-Off', 4),
      }),
    ).toEqual({ activeRegime: 'Risk-Off', persistenceDaysCount: 0 });
  });

  it('streak broken by different non-active candidate → new streak count=1', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-On',
        crisisFired: false,
        prior: prior('Caution', 'Risk-Off', 3),
      }),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 1 });
  });

  it('prior at active state (count=0) + new divergent candidate → count=1 (start streak)', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-Off',
        crisisFired: false,
        prior: prior('Caution', 'Caution', 0),
      }),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 1 });
  });

  it('flip to Risk-On after 5-day streak', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-On',
        crisisFired: false,
        prior: prior('Caution', 'Risk-On', 4),
      }),
    ).toEqual({ activeRegime: 'Risk-On', persistenceDaysCount: 0 });
  });

  it('flip-back: prior active=Risk-Off, candidate Caution day-by-day flips back after 5 days', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Caution',
        crisisFired: false,
        prior: prior('Risk-Off', 'Caution', 4),
      }),
    ).toEqual({ activeRegime: 'Caution', persistenceDaysCount: 0 });
  });

  it('crisis takes precedence over an in-progress streak (count resets to 0)', () => {
    expect(
      resolveActiveRegime({
        candidateRegime: 'Risk-Off',
        crisisFired: true,
        prior: prior('Caution', 'Risk-On', 3),
      }),
    ).toEqual({ activeRegime: 'Risk-Off', persistenceDaysCount: 0 });
  });
});

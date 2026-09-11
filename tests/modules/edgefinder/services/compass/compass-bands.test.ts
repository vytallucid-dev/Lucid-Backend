import { describe, it, expect } from 'vitest';
import {
  evaluateVix,
  evaluateHyOas,
  evaluate2s10s,
  evaluateDxyTrend,
  evaluateVixTermStructure,
  evaluateCpiTrajectory,
  evaluateGdpLevel,
  evaluateJobs,
  aggregateUsDataStack,
  evaluateRealYieldShock,
} from '@modules/edgefinder/services/compass/compass-bands';
import type { CompassConfigDefinition } from '@modules/edgefinder/services/compass/compass-config.types';
import { COMPASS_CONFIG_V1_FIXTURE as cfg } from './compass-config.fixture';

describe('evaluateVix', () => {
  it('GREEN below 18', () => {
    expect(evaluateVix(17.9, cfg)).toBe('GREEN');
    expect(evaluateVix(10, cfg)).toBe('GREEN');
  });
  it('YELLOW at 18 and at 25 (inclusive)', () => {
    expect(evaluateVix(18, cfg)).toBe('YELLOW');
    expect(evaluateVix(20, cfg)).toBe('YELLOW');
    expect(evaluateVix(25, cfg)).toBe('YELLOW');
  });
  it('RED above 25', () => {
    expect(evaluateVix(25.1, cfg)).toBe('RED');
    expect(evaluateVix(40, cfg)).toBe('RED');
  });
});

describe('evaluateHyOas', () => {
  it('GREEN when both delta10 and level are calm', () => {
    expect(evaluateHyOas(4.0, 0.1, cfg)).toBe('GREEN');
  });
  it('RED when delta10 > 0.75 regardless of level', () => {
    expect(evaluateHyOas(4.0, 0.76, cfg)).toBe('RED');
  });
  it('RED when level > 5.50 regardless of delta10', () => {
    expect(evaluateHyOas(5.51, 0, cfg)).toBe('RED');
  });
  it('YELLOW when delta10 > 0.40 but <= 0.75 and level calm', () => {
    expect(evaluateHyOas(4.0, 0.5, cfg)).toBe('YELLOW');
  });
  it('YELLOW when level > 4.50 but <= 5.50 and delta10 calm', () => {
    expect(evaluateHyOas(5.0, 0, cfg)).toBe('YELLOW');
  });
  it('GREEN when delta10 is null (treated as no velocity signal) and level calm', () => {
    expect(evaluateHyOas(4.0, null, cfg)).toBe('GREEN');
  });
});

describe('evaluate2s10s', () => {
  it('RED when inside red window AND jobs sub-check is not GREEN (rule 1, takes precedence)', () => {
    expect(evaluate2s10s(0.5, 0.1, true, 'YELLOW', cfg)).toBe('RED');
    expect(evaluate2s10s(0.5, 0.1, true, 'RED', cfg)).toBe('RED');
  });
  it('does NOT fire rule 1 when inside red window but jobs sub-check IS GREEN', () => {
    // falls through to rule 2/3 instead
    expect(evaluate2s10s(0.5, 0.1, true, 'GREEN', cfg)).toBe('GREEN');
  });
  it('GREEN when non-negative and delta30 >= floor (rule 2)', () => {
    expect(evaluate2s10s(0.42, 0, false, 'YELLOW', cfg)).toBe('GREEN');
    expect(evaluate2s10s(0, -0.05, false, 'YELLOW', cfg)).toBe('GREEN'); // exact floor, inclusive
  });
  it('YELLOW when negative (not inside red window)', () => {
    expect(evaluate2s10s(-0.1, 0.1, false, 'YELLOW', cfg)).toBe('YELLOW');
  });
  it('YELLOW when non-negative but delta30 below floor', () => {
    expect(evaluate2s10s(0.1, -0.06, false, 'YELLOW', cfg)).toBe('YELLOW');
  });
  it('YELLOW when delta30 is null (insufficient history)', () => {
    expect(evaluate2s10s(0.25, null, false, 'YELLOW', cfg)).toBe('YELLOW');
  });
});

describe('evaluateDxyTrend', () => {
  it('GREEN when calm (dev <= 2% and move5 <= 2%)', () => {
    expect(evaluateDxyTrend(0.01, 0.01, cfg)).toBe('GREEN');
    expect(evaluateDxyTrend(0.02, 0.02, cfg)).toBe('GREEN');
  });
  it('YELLOW when dev > 2% but move5 <= 3%', () => {
    expect(evaluateDxyTrend(0.025, 0.01, cfg)).toBe('YELLOW');
  });
  it('RED when move5 > 3% regardless of dev', () => {
    expect(evaluateDxyTrend(0.01, 0.031, cfg)).toBe('RED');
  });
});

describe('evaluateVixTermStructure', () => {
  it('GREEN in normal contango (ts_ratio well below 0.90)', () => {
    expect(evaluateVixTermStructure(0.84, cfg)).toBe('GREEN');
  });
  it('YELLOW between 0.90 (inclusive) and 1.00', () => {
    expect(evaluateVixTermStructure(0.9, cfg)).toBe('YELLOW');
    expect(evaluateVixTermStructure(0.95, cfg)).toBe('YELLOW');
    expect(evaluateVixTermStructure(1.0, cfg)).toBe('YELLOW');
  });
  it('RED when backwardated (ts_ratio > 1.00)', () => {
    expect(evaluateVixTermStructure(1.01, cfg)).toBe('RED');
  });
});

describe('evaluateCpiTrajectory', () => {
  it('rising → RED, falling → GREEN, mixed → YELLOW', () => {
    expect(evaluateCpiTrajectory('rising')).toBe('RED');
    expect(evaluateCpiTrajectory('falling')).toBe('GREEN');
    expect(evaluateCpiTrajectory('mixed')).toBe('YELLOW');
  });
});

describe('evaluateGdpLevel', () => {
  it('both > 1.5 → GREEN', () => {
    expect(evaluateGdpLevel([2.0, 2.2], cfg)).toBe('GREEN');
  });
  it('any < 0 → RED', () => {
    expect(evaluateGdpLevel([-0.5, 1.0], cfg)).toBe('RED');
    expect(evaluateGdpLevel([1.0, -0.5], cfg)).toBe('RED');
  });
  it('mixed positive sub-1.5 → YELLOW', () => {
    expect(evaluateGdpLevel([0.5, 1.0], cfg)).toBe('YELLOW');
  });
  it('YELLOW when fewer than 2 values', () => {
    expect(evaluateGdpLevel([2.0], cfg)).toBe('YELLOW');
  });
});

describe('evaluateJobs', () => {
  it('RED when Sahm triggered regardless of NFP', () => {
    expect(evaluateJobs(true, [200, 200, 200], cfg)).toBe('RED');
  });
  it('GREEN when avg NFP > 100k', () => {
    expect(evaluateJobs(false, [150, 120, 110], cfg)).toBe('GREEN');
  });
  it('RED when avg NFP < 50k', () => {
    expect(evaluateJobs(false, [30, 40, 35], cfg)).toBe('RED');
  });
  it('YELLOW in between', () => {
    expect(evaluateJobs(false, [80, 60, 70], cfg)).toBe('YELLOW');
  });
  it('YELLOW when no NFP data', () => {
    expect(evaluateJobs(false, [], cfg)).toBe('YELLOW');
  });
});

describe('aggregateUsDataStack', () => {
  it('two GREEN → GREEN', () => {
    expect(aggregateUsDataStack('GREEN', 'GREEN', 'YELLOW', cfg)).toBe('GREEN');
  });
  it('two RED → RED', () => {
    expect(aggregateUsDataStack('RED', 'RED', 'YELLOW', cfg)).toBe('RED');
  });
  it('mixed 1/1/1 → YELLOW', () => {
    expect(aggregateUsDataStack('RED', 'GREEN', 'YELLOW', cfg)).toBe('YELLOW');
  });
  it('all YELLOW → YELLOW', () => {
    expect(aggregateUsDataStack('YELLOW', 'YELLOW', 'YELLOW', cfg)).toBe('YELLOW');
  });
  it('three GREEN → GREEN', () => {
    expect(aggregateUsDataStack('GREEN', 'GREEN', 'GREEN', cfg)).toBe('GREEN');
  });
});

describe('Phase C — evaluateRealYieldShock (R1, non-voting)', () => {
  const withYields: CompassConfigDefinition = {
    ...cfg,
    yields: {
      real_yield_shock_60d_red_bp: 60,
      real_yield_shock_60d_yellow_bp: 30,
      curve_green_requires_no_real_shock: true,
    },
  };

  it.each([
    [120, 'RED'],
    [60, 'RED'],
    [59.9, 'YELLOW'],
    [30, 'YELLOW'],
    [29.9, 'GREEN'],
    [0, 'GREEN'],
  ])('%dbp -> %s', (bp, expected) => {
    expect(evaluateRealYieldShock(bp as number, withYields)).toBe(expected);
  });

  it('is one-sided: a fast FALL in real yields is GREEN, not a shock', () => {
    // A symmetric negative leg was never tested and must not be inferred.
    expect(evaluateRealYieldShock(-80, withYields)).toBe('GREEN');
  });

  it('returns null when the change cannot be computed', () => {
    // Insufficient history, a stale series, or any date before DFII10 begins.
    expect(evaluateRealYieldShock(null, withYields)).toBeNull();
  });

  it('returns null under a config that predates the yields block (v1/v2)', () => {
    expect(evaluateRealYieldShock(120, cfg)).toBeNull();
  });
});

describe('Phase C — the 2s10s GREEN gate', () => {
  const gated: CompassConfigDefinition = {
    ...cfg,
    yields: {
      real_yield_shock_60d_red_bp: 60,
      real_yield_shock_60d_yellow_bp: 30,
      curve_green_requires_no_real_shock: true,
    },
  };
  // Satisfies the GREEN clause: positive curve, delta at the floor.
  const GREEN_ARGS = [0.5, 0.0, false, 'GREEN' as const] as const;

  it('votes GREEN when R1 is not RED', () => {
    expect(evaluate2s10s(...GREEN_ARGS, gated, 'GREEN')).toBe('GREEN');
    expect(evaluate2s10s(...GREEN_ARGS, gated, 'YELLOW')).toBe('GREEN');
  });

  it('falls through to YELLOW when R1 is RED', () => {
    expect(evaluate2s10s(...GREEN_ARGS, gated, 'RED')).toBe('YELLOW');
  });

  it('is inert when R1 is unavailable — a null band never blocks GREEN', () => {
    // Pre-2003, stale, or insufficient history. Failing open is the correct
    // direction: missing data must not manufacture a more negative reading.
    expect(evaluate2s10s(...GREEN_ARGS, gated, null)).toBe('GREEN');
  });

  it('is inert under a config without the yields block', () => {
    expect(evaluate2s10s(...GREEN_ARGS, cfg, 'RED')).toBe('GREEN');
  });

  it('is inert when the flag is explicitly false', () => {
    const off: CompassConfigDefinition = {
      ...gated,
      yields: { ...gated.yields!, curve_green_requires_no_real_shock: false },
    };
    expect(evaluate2s10s(...GREEN_ARGS, off, 'RED')).toBe('GREEN');
  });

  it('never overrides the RED clause — an inversion red window still wins', () => {
    expect(evaluate2s10s(0.5, 0.0, true, 'YELLOW', gated, 'RED')).toBe('RED');
    expect(evaluate2s10s(0.5, 0.0, true, 'YELLOW', gated, null)).toBe('RED');
  });

  it('THE POINT: the gate can only move GREEN->YELLOW, never toward RED', () => {
    // This is why it removes false Risk-On days rather than creating Risk-Off
    // ones — candidate Risk-Off is gated on RED weight alone, and this gate
    // cannot add any. Exhaustive over the inputs that reach the GREEN clause.
    for (const t10y2y of [0, 0.5, 2.0]) {
      for (const delta30 of [-0.05, 0, 0.5]) {
        for (const jobs of ['GREEN', 'YELLOW', 'RED'] as const) {
          const ungated = evaluate2s10s(t10y2y, delta30, false, jobs, gated, 'GREEN');
          const withShock = evaluate2s10s(t10y2y, delta30, false, jobs, gated, 'RED');
          expect(withShock).not.toBe('RED');
          if (ungated === 'GREEN') expect(withShock).toBe('YELLOW');
          else expect(withShock).toBe(ungated);
        }
      }
    }
  });
});

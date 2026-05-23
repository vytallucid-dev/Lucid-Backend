import { describe, it, expect } from 'vitest';
import {
  evaluateVix,
  evaluateHyOas,
  evaluate2s10s,
  evaluateDxyTrend,
  evaluateGoldDxyCorrelation,
  evaluateCpiTrajectory,
  evaluateGdpLevel,
  evaluateJobs,
  aggregateUsDataStack,
} from '@modules/edgefinder/services/compass/compass-bands';

describe('evaluateVix', () => {
  it('GREEN below 18', () => {
    expect(evaluateVix(17.9)).toBe('GREEN');
    expect(evaluateVix(10)).toBe('GREEN');
  });
  it('YELLOW at 18 and at 25 (inclusive)', () => {
    expect(evaluateVix(18)).toBe('YELLOW');
    expect(evaluateVix(20)).toBe('YELLOW');
    expect(evaluateVix(25)).toBe('YELLOW');
  });
  it('RED above 25', () => {
    expect(evaluateVix(25.1)).toBe('RED');
    expect(evaluateVix(40)).toBe('RED');
  });
});

describe('evaluateHyOas', () => {
  it('RED above 7.00', () => {
    expect(evaluateHyOas(7.5, -0.05)).toBe('RED');
  });
  it('GREEN when < 4.50 and tightening (30d change negative)', () => {
    expect(evaluateHyOas(4.0, -0.1)).toBe('GREEN');
  });
  it('YELLOW when < 4.50 but widening', () => {
    expect(evaluateHyOas(4.0, 0.1)).toBe('YELLOW');
  });
  it('YELLOW when between 4.50 and 7.00', () => {
    expect(evaluateHyOas(5.5, -0.05)).toBe('YELLOW');
    expect(evaluateHyOas(6.0, 0.05)).toBe('YELLOW');
  });
  it('YELLOW when 30-day change is null and level is between thresholds', () => {
    expect(evaluateHyOas(5.0, null)).toBe('YELLOW');
  });
});

describe('evaluate2s10s', () => {
  it('GREEN when positive and steepening', () => {
    expect(evaluate2s10s(0.25, 0.05)).toBe('GREEN');
  });
  it('YELLOW when inverted and stable', () => {
    expect(evaluate2s10s(-0.3, 0.05)).toBe('YELLOW');
  });
  it('RED when inverted and re-steepening fast (>0.1 30d)', () => {
    expect(evaluate2s10s(-0.3, 0.2)).toBe('RED');
  });
  it('YELLOW when 30-day change is null', () => {
    expect(evaluate2s10s(0.25, null)).toBe('YELLOW');
  });
});

describe('evaluateDxyTrend', () => {
  it('YELLOW when range-bound (|distance| ≤2% and |5d change| ≤3%)', () => {
    expect(evaluateDxyTrend(1.5, 1)).toBe('YELLOW');
    expect(evaluateDxyTrend(-1.5, -2)).toBe('YELLOW');
  });
  it('GREEN when distance > 2% in either direction', () => {
    expect(evaluateDxyTrend(2.5, 1)).toBe('GREEN');
    expect(evaluateDxyTrend(-2.5, -1)).toBe('GREEN');
  });
  it('RED when 5-day pct change > 3% in either direction', () => {
    expect(evaluateDxyTrend(2.5, 3.5)).toBe('RED');
    expect(evaluateDxyTrend(-1, -3.5)).toBe('RED');
  });
});

describe('evaluateGoldDxyCorrelation', () => {
  it('GREEN at strong inverse correlation', () => {
    expect(evaluateGoldDxyCorrelation(-0.7)).toBe('GREEN');
  });
  it('YELLOW between -0.5 and 0', () => {
    expect(evaluateGoldDxyCorrelation(-0.2)).toBe('YELLOW');
    expect(evaluateGoldDxyCorrelation(0)).toBe('YELLOW');
  });
  it('RED when correlation flips positive', () => {
    expect(evaluateGoldDxyCorrelation(0.3)).toBe('RED');
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
    expect(evaluateGdpLevel([2.0, 2.2])).toBe('GREEN');
  });
  it('any < 0 → RED', () => {
    expect(evaluateGdpLevel([-0.5, 1.0])).toBe('RED');
    expect(evaluateGdpLevel([1.0, -0.5])).toBe('RED');
  });
  it('mixed positive sub-1.5 → YELLOW', () => {
    expect(evaluateGdpLevel([0.5, 1.0])).toBe('YELLOW');
  });
  it('YELLOW when fewer than 2 values', () => {
    expect(evaluateGdpLevel([2.0])).toBe('YELLOW');
  });
});

describe('evaluateJobs', () => {
  it('RED when Sahm triggered regardless of NFP', () => {
    expect(evaluateJobs(true, [200, 200, 200])).toBe('RED');
  });
  it('GREEN when avg NFP > 100k', () => {
    expect(evaluateJobs(false, [150, 120, 110])).toBe('GREEN');
  });
  it('RED when avg NFP < 50k', () => {
    expect(evaluateJobs(false, [30, 40, 35])).toBe('RED');
  });
  it('YELLOW in between', () => {
    expect(evaluateJobs(false, [80, 60, 70])).toBe('YELLOW');
  });
  it('YELLOW when no NFP data', () => {
    expect(evaluateJobs(false, [])).toBe('YELLOW');
  });
});

describe('aggregateUsDataStack', () => {
  it('two GREEN → GREEN', () => {
    expect(aggregateUsDataStack('GREEN', 'GREEN', 'YELLOW')).toBe('GREEN');
  });
  it('two RED → RED', () => {
    expect(aggregateUsDataStack('RED', 'RED', 'YELLOW')).toBe('RED');
  });
  it('mixed 1/1/1 → YELLOW', () => {
    expect(aggregateUsDataStack('RED', 'GREEN', 'YELLOW')).toBe('YELLOW');
  });
  it('all YELLOW → YELLOW', () => {
    expect(aggregateUsDataStack('YELLOW', 'YELLOW', 'YELLOW')).toBe('YELLOW');
  });
  it('three GREEN → GREEN', () => {
    expect(aggregateUsDataStack('GREEN', 'GREEN', 'GREEN')).toBe('GREEN');
  });
});

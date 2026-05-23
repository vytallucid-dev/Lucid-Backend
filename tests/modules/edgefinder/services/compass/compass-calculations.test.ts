import { describe, it, expect } from 'vitest';
import {
  compute5DayAverage,
  compute50DaySMA,
  computePctDistance,
  compute5DayPctChange,
  compute30DayChange,
  computePearsonCorrelation,
  computeYoYSequence,
  computeQoQSequence,
  detectTrajectory,
  computeSahmRule,
  computeRecentNFPChanges,
  alignByDate,
} from '@modules/edgefinder/services/compass/compass-calculations';

describe('compute5DayAverage', () => {
  it('returns null when fewer than 5 values', () => {
    expect(compute5DayAverage([1, 2, 3, 4])).toBeNull();
  });
  it('uses only the last 5 values', () => {
    expect(compute5DayAverage([10, 10, 10, 1, 2, 3, 4, 5])).toBe(3);
  });
  it('returns the mean of exactly 5 values', () => {
    expect(compute5DayAverage([2, 4, 6, 8, 10])).toBe(6);
  });
});

describe('compute50DaySMA', () => {
  it('returns null when fewer than 50 values', () => {
    expect(compute50DaySMA(new Array(49).fill(1))).toBeNull();
  });
  it('returns the mean of the last 50 values', () => {
    const arr = [...new Array(50).fill(99), ...new Array(50).fill(100)];
    expect(compute50DaySMA(arr)).toBe(100);
  });
});

describe('computePctDistance', () => {
  it('returns positive when current is above SMA', () => {
    expect(computePctDistance(105, 100)).toBeCloseTo(5, 6);
  });
  it('returns negative when current is below SMA', () => {
    expect(computePctDistance(95, 100)).toBeCloseTo(-5, 6);
  });
  it('returns 0 when SMA is 0 (guard)', () => {
    expect(computePctDistance(100, 0)).toBe(0);
  });
});

describe('compute5DayPctChange', () => {
  it('returns null when fewer than 6 values', () => {
    expect(compute5DayPctChange([1, 2, 3, 4, 5])).toBeNull();
  });
  it('computes pct change between last and 5-back', () => {
    // [100, x, x, x, x, 103] → 3% change
    expect(compute5DayPctChange([100, 1, 1, 1, 1, 103])).toBeCloseTo(3, 6);
  });
});

describe('compute30DayChange', () => {
  it('returns null when fewer than 31 values', () => {
    expect(compute30DayChange(new Array(30).fill(1))).toBeNull();
  });
  it('returns last minus 31st-from-end', () => {
    const arr = [100, ...new Array(29).fill(0), 150];
    // values[0] = 100, values[30] = 150 → 50
    expect(compute30DayChange(arr)).toBe(50);
  });
});

describe('computePearsonCorrelation', () => {
  it('returns 1 for perfect positive correlation', () => {
    expect(computePearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
  });
  it('returns -1 for perfect negative correlation', () => {
    expect(computePearsonCorrelation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 6);
  });
  it('returns null when arrays differ in length', () => {
    expect(computePearsonCorrelation([1, 2, 3], [1, 2])).toBeNull();
  });
  it('returns null when one series has zero variance', () => {
    expect(computePearsonCorrelation([1, 2, 3], [5, 5, 5])).toBeNull();
  });
  it('handles realistic uncorrelated data near zero', () => {
    const corr = computePearsonCorrelation([1, 2, 3, 4], [3, 1, 4, 2]);
    expect(corr).not.toBeNull();
    expect(Math.abs(corr as number)).toBeLessThan(0.5);
  });
});

describe('computeYoYSequence', () => {
  it('returns null for indices < 12 and YoY for later indices', () => {
    const monthlyLevels = [
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, // months 0-11
      112, // month 12 → (112-100)/100 = 12%
      113.13, // month 13 → (113.13-101)/101 ≈ 12.01%
    ];
    const yoy = computeYoYSequence(monthlyLevels);
    expect(yoy[11]).toBeNull();
    expect(yoy[12]).toBeCloseTo(12, 4);
    expect(yoy[13]).toBeCloseTo(12.0099, 2);
  });
});

describe('computeQoQSequence', () => {
  it('first element is null; later elements are QoQ %', () => {
    const qoq = computeQoQSequence([100, 102, 103]);
    expect(qoq[0]).toBeNull();
    expect(qoq[1]).toBeCloseTo(2, 6);
    expect(qoq[2]).toBeCloseTo(0.9803, 3);
  });
});

describe('detectTrajectory', () => {
  it('detects strictly rising', () => {
    expect(detectTrajectory([1, 2, 3])).toBe('rising');
  });
  it('detects strictly falling', () => {
    expect(detectTrajectory([3, 2, 1])).toBe('falling');
  });
  it('detects mixed', () => {
    expect(detectTrajectory([1, 3, 2])).toBe('mixed');
  });
  it('treats flat as mixed (not strictly rising or falling)', () => {
    expect(detectTrajectory([1, 1, 1])).toBe('mixed');
  });
});

describe('computeSahmRule', () => {
  it('returns null when fewer than 12 monthly values', () => {
    expect(computeSahmRule([3.5, 3.6, 3.7])).toBeNull();
  });
  it('triggers when 3-month avg is 0.5pp above 12-month low', () => {
    // 12-month low = 3.7, last 3 avg = (4.3+4.3+4.3)/3 = 4.3 → delta 0.6 → triggered
    const rates = [3.7, 3.8, 3.9, 4.0, 4.1, 4.2, 4.0, 3.9, 3.8, 4.3, 4.3, 4.3];
    const result = computeSahmRule(rates);
    expect(result).not.toBeNull();
    expect((result as { triggered: boolean }).triggered).toBe(true);
    expect((result as { delta: number }).delta).toBeCloseTo(0.6, 6);
  });
  it('does not trigger when delta < 0.5pp', () => {
    const rates = [3.7, 3.7, 3.7, 3.7, 3.7, 3.7, 3.7, 3.7, 3.7, 4.0, 4.0, 4.0];
    const result = computeSahmRule(rates);
    expect((result as { triggered: boolean }).triggered).toBe(false);
    expect((result as { delta: number }).delta).toBeCloseTo(0.3, 6);
  });
});

describe('computeRecentNFPChanges', () => {
  it('returns last 3 month-over-month deltas', () => {
    // [156000, 156150, 156300, 156400] → [156150-156000, 156300-156150, 156400-156300] = [150, 150, 100]
    const deltas = computeRecentNFPChanges([156000, 156150, 156300, 156400]);
    expect(deltas).toEqual([150, 150, 100]);
  });
  it('returns empty array when fewer than 4 values', () => {
    expect(computeRecentNFPChanges([1, 2, 3])).toEqual([]);
  });
});

describe('alignByDate', () => {
  it('returns pairs only for dates present in both series', () => {
    const a = [
      { date: new Date('2026-05-12T00:00:00Z'), value: 1 },
      { date: new Date('2026-05-13T00:00:00Z'), value: 2 },
      { date: new Date('2026-05-14T00:00:00Z'), value: 3 },
    ];
    const b = [
      { date: new Date('2026-05-13T00:00:00Z'), value: 20 },
      { date: new Date('2026-05-14T00:00:00Z'), value: 30 },
      { date: new Date('2026-05-15T00:00:00Z'), value: 40 },
    ];
    const aligned = alignByDate(a, b);
    expect(aligned.xs).toEqual([2, 3]);
    expect(aligned.ys).toEqual([20, 30]);
  });
});

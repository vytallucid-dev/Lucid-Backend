import { describe, it, expect } from 'vitest';
import {
  computeCotDerivedFields,
  computeReleaseDate,
  parseCftcReportDate,
  safeParseInt,
} from '@modules/edgefinder/services/cftc-cot-calculations';

describe('computeCotDerivedFields', () => {
  it('computes percentages and changes for a representative row', () => {
    const d = computeCotDerivedFields(412580, 307440, 3201, -1890);
    expect(d.longContracts).toBe(412580);
    expect(d.shortContracts).toBe(307440);
    expect(d.longPct).toBeCloseTo(57.3, 1);
    expect(d.shortPct).toBeCloseTo(42.7, 1);
    expect(d.longPct + d.shortPct).toBeCloseTo(100, 6);
    expect(d.changeInLongContracts).toBe(3201);
    expect(d.changeInShortContracts).toBe(-1890);
    expect(d.changeInLongPct).not.toBeNull();
    expect(d.changeInShortPct).not.toBeNull();
    expect(d.changeInLongPct as number).toBeCloseTo(0.78, 1);
    expect(d.changeInShortPct as number).toBeCloseTo(-0.61, 1);
    expect(d.weeklyChangePct).not.toBeNull();
    expect(d.weeklyChangePct as number).toBeCloseTo(1.39, 1);
  });

  it('defaults to 50/50 when total positions is zero', () => {
    const d = computeCotDerivedFields(0, 0, 0, 0);
    expect(d.longPct).toBe(50);
    expect(d.shortPct).toBe(50);
  });

  it('returns null change percentages when prior-week longs is zero', () => {
    const d = computeCotDerivedFields(100, 200, 100, 10);
    expect(d.changeInLongPct).toBeNull();
    expect(d.weeklyChangePct).toBeNull();
  });

  it('returns null change percentages when prior-week shorts is zero', () => {
    const d = computeCotDerivedFields(100, 200, 10, 200);
    expect(d.changeInShortPct).toBeNull();
    expect(d.weeklyChangePct).toBeNull();
  });

  it('handles negative changes correctly', () => {
    const d = computeCotDerivedFields(1000, 500, -100, -50);
    // last week: long=1100, short=550
    expect(d.changeInLongPct as number).toBeCloseTo((-100 / 1100) * 100, 6);
    expect(d.changeInShortPct as number).toBeCloseTo((-50 / 550) * 100, 6);
  });
});

describe('computeReleaseDate', () => {
  it('returns the Friday after a Tuesday report date', () => {
    const tuesday = new Date(Date.UTC(2026, 4, 13)); // 2026-05-13 (Tuesday)
    const friday = computeReleaseDate(tuesday);
    expect(friday.toISOString()).toBe('2026-05-16T00:00:00.000Z');
  });

  it('does not mutate the input', () => {
    const tuesday = new Date(Date.UTC(2026, 4, 13));
    const original = tuesday.toISOString();
    computeReleaseDate(tuesday);
    expect(tuesday.toISOString()).toBe(original);
  });
});

describe('parseCftcReportDate', () => {
  it('parses YYYY-MM-DDT00:00:00.000 string into UTC midnight date', () => {
    const d = parseCftcReportDate('2026-05-13T00:00:00.000');
    expect(d.toISOString()).toBe('2026-05-13T00:00:00.000Z');
  });

  it('parses date-only strings', () => {
    const d = parseCftcReportDate('2026-05-13');
    expect(d.toISOString()).toBe('2026-05-13T00:00:00.000Z');
  });
});

describe('safeParseInt', () => {
  it('parses numeric strings', () => {
    expect(safeParseInt('1234')).toBe(1234);
    expect(safeParseInt('-50')).toBe(-50);
    expect(safeParseInt('0')).toBe(0);
  });

  it('returns null for empty / undefined / null', () => {
    expect(safeParseInt('')).toBeNull();
    expect(safeParseInt(undefined)).toBeNull();
    expect(safeParseInt(null)).toBeNull();
  });

  it('returns null for non-numeric strings', () => {
    expect(safeParseInt('abc')).toBeNull();
  });
});

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    dataPoint: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    // findLatestRelease also resolves variant ordinals via getOrdinalMap.
    // Empty here is correct for every fixture in this file — none registers
    // variants, so ordinalOf falls back to -1 for all rows regardless.
    indicatorVariant: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { prisma } from '@core/db/prisma';
import { rateDecisionHandler } from '@core/scoring/handlers/rate-decision.handler';
import { ScoringContext } from '@core/scoring/types';

const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedFindMany = prisma.dataPoint.findMany as unknown as ReturnType<typeof vi.fn>;

function ctx(): ScoringContext {
  return {
    indicatorId: 'ind-1',
    indicatorCode: 'US_FED_RATE',
    observationDate: new Date('2026-05-15'),
    ruleVersionId: 'rule-1',
    ruleDefinition: { type: 'rate_decision' },
  };
}

// Rate decisions score SURPRISE (actual vs expected), not the absolute action
// — unchanged. What changed is the unit: the columns hold rate LEVELS in
// percentage points, like every other indicator, rather than bps changes
// against the prior decision. The baseline cancels out of the subtraction, so
// every score below is the same one the bps form produced; see
// rate-decision.helpers.ts.
//
// Each case is written as (actual level, expected level, prior level) with a
// 4.00% baseline, and its old bps framing is named in the test title so the
// equivalence stays checkable.
function mockDp(value: number, forecastValue: number | null, previousValue: number | null = 4.0): void {
  const dp = {
    id: 'dp-1',
    value,
    forecastValue,
    previousValue,
    observationDate: new Date('2026-05-01'),
    variant: null,
    vintageDate: new Date('2026-05-01'),
  };
  // findLatestRelease resolves via findFirst (date probe, select-only) then
  // findMany (full candidate rows for that date, fed through
  // pickLatestRelease). The handler's returned dp comes from findMany's
  // result, not findFirst's — both must reflect the same row or the test
  // would pass while never exercising the real tiebreak path.
  mockedFindFirst.mockResolvedValueOnce({ observationDate: dp.observationDate });
  mockedFindMany.mockResolvedValueOnce([dp]);
}

describe('rateDecisionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('More hawkish than expected: hike 25bp, 0bp expected → score +1', async () => {
    mockDp(4.25, 4.0);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(1);
      expect(r.metadata.decision).toBe('HIKE');
      expect(r.metadata.surprise_direction).toBe('HAWKISH');
      expect(r.metadata.surprise_bps).toBeCloseTo(25, 6);
      expect(r.metadata.surprise_pp).toBeCloseTo(0.25, 6);
    }
  });

  it('Expected hike: hike 25bp, 25bp expected → score 0', async () => {
    mockDp(4.25, 4.25);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.decision).toBe('HIKE');
      expect(r.metadata.surprise_direction).toBe('AS_EXPECTED');
    }
  });

  it('Hold when hike was expected: 0bp actual, 25bp expected → score -1', async () => {
    mockDp(4.0, 4.25);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(-1);
      expect(r.metadata.decision).toBe('HOLD');
      expect(r.metadata.surprise_direction).toBe('DOVISH');
    }
  });

  it('Smaller hike than expected: 25bp actual, 50bp expected → score -1', async () => {
    mockDp(4.25, 4.5);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(-1);
      expect(r.metadata.surprise_direction).toBe('DOVISH');
    }
  });

  it('More dovish than expected: cut 25bp, 0bp expected → score -1', async () => {
    mockDp(3.75, 4.0);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(-1);
      expect(r.metadata.decision).toBe('CUT');
      expect(r.metadata.surprise_direction).toBe('DOVISH');
    }
  });

  it('Expected hold: 0bp actual, 0bp expected → score 0', async () => {
    mockDp(4.0, 4.0);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.decision).toBe('HOLD');
      expect(r.metadata.surprise_direction).toBe('AS_EXPECTED');
    }
  });

  it('Surprise within tolerance (0.005bp of float noise) → AS_EXPECTED, not a surprise', async () => {
    mockDp(4.2500_5, 4.25);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.surprise_direction).toBe('AS_EXPECTED');
    }
  });

  it('No expectation on file (forecastValue null) → insufficient_data, score 0 via carry/absent', async () => {
    mockDp(4.25, null);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('insufficient_data');
    if (r.kind === 'insufficient_data') {
      expect(r.reason).toMatch(/No expected rate on file/);
      expect(r.details?.rate_level).toBe(4.25);
      expect(r.details?.prior_rate_level).toBe(4.0);
      expect(r.details?.decision).toBe('HIKE');
    }
  });

  it('First decision on file WITH a forecast is scorable — the bps shape could not', async () => {
    // Converting a forecast to a bps change needed a prior rate, so a first
    // release stored forecastValue null and could never be scored, even though
    // the surprise was knowable from the two levels the whole time.
    mockDp(4.25, 4.0, null);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(1);
      expect(r.metadata.surprise_direction).toBe('HAWKISH');
      expect(r.metadata.surprise_bps).toBeCloseTo(25, 6);
    }
  });

  it('First decision reports no decision rather than a fabricated HOLD', async () => {
    // The bps shape hardcoded a 0 change when there was no prior, so "we do
    // not know what this moved from" and "it did not move" were the same
    // value. They are different facts.
    mockDp(4.25, 4.25, null);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.metadata.decision).toBeNull();
      expect(r.score).toBe(0);
    }
  });

  it('No data point → insufficient_data', async () => {
    mockedFindFirst.mockResolvedValueOnce(null);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('insufficient_data');
    if (r.kind === 'insufficient_data') {
      expect(r.reason).toMatch(/No rate decision/);
    }
  });
});

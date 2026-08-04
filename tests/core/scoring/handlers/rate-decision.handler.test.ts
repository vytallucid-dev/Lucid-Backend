import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    dataPoint: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@core/db/prisma';
import { rateDecisionHandler } from '@core/scoring/handlers/rate-decision.handler';
import { ScoringContext } from '@core/scoring/types';

const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;

function ctx(): ScoringContext {
  return {
    indicatorId: 'ind-1',
    indicatorCode: 'US_FED_RATE',
    observationDate: new Date('2026-05-15'),
    ruleVersionId: 'rule-1',
    ruleDefinition: { type: 'rate_decision' },
  };
}

// Change 2: rate decision scores surprise (actual bps vs expected bps), not
// the absolute action. `value` = actual bps change, `forecastValue` =
// expected bps change — both in the same unit (see rate-decision.helpers.ts).
function mockDp(value: number, forecastValue: number | null): void {
  mockedFindFirst.mockResolvedValueOnce({
    id: 'dp-1',
    value,
    forecastValue,
    observationDate: new Date('2026-05-01'),
  });
}

describe('rateDecisionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('More hawkish than expected: hike 25bp, 0bp expected → score +1', async () => {
    mockDp(25, 0);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(1);
      expect(r.metadata.decision).toBe('HIKE');
      expect(r.metadata.surprise_direction).toBe('HAWKISH');
      expect(r.metadata.surprise_bps).toBeCloseTo(25, 6);
    }
  });

  it('Expected hike: hike 25bp, 25bp expected → score 0', async () => {
    mockDp(25, 25);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.decision).toBe('HIKE');
      expect(r.metadata.surprise_direction).toBe('AS_EXPECTED');
    }
  });

  it('Hold when hike was expected: 0bp actual, 25bp expected → score -1', async () => {
    mockDp(0, 25);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(-1);
      expect(r.metadata.decision).toBe('HOLD');
      expect(r.metadata.surprise_direction).toBe('DOVISH');
    }
  });

  it('Smaller hike than expected: 25bp actual, 50bp expected → score -1', async () => {
    mockDp(25, 50);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(-1);
      expect(r.metadata.surprise_direction).toBe('DOVISH');
    }
  });

  it('More dovish than expected: cut 25bp, 0bp expected → score -1', async () => {
    mockDp(-25, 0);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(-1);
      expect(r.metadata.decision).toBe('CUT');
      expect(r.metadata.surprise_direction).toBe('DOVISH');
    }
  });

  it('Expected hold: 0bp actual, 0bp expected → score 0', async () => {
    mockDp(0, 0);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.decision).toBe('HOLD');
      expect(r.metadata.surprise_direction).toBe('AS_EXPECTED');
    }
  });

  it('Surprise within tolerance (0.005bp, float noise) → AS_EXPECTED, not a surprise', async () => {
    mockDp(25.005, 25);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.surprise_direction).toBe('AS_EXPECTED');
    }
  });

  it('No expectation on file (forecastValue null) → insufficient_data, score 0 via carry/absent', async () => {
    mockDp(25, null);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('insufficient_data');
    if (r.kind === 'insufficient_data') {
      expect(r.reason).toMatch(/No expected rate on file/);
      expect(r.details?.bps_change).toBe(25);
      expect(r.details?.decision).toBe('HIKE');
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

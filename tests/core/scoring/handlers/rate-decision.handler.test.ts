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

function mockDp(value: number): void {
  mockedFindFirst.mockResolvedValueOnce({
    id: 'dp-1',
    value,
    observationDate: new Date('2026-05-01'),
  });
}

describe('rateDecisionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Hike: value=25 → score +1', async () => {
    mockDp(25);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(1);
      expect(r.metadata.decision).toBe('HIKE');
    }
  });

  it('Cut: value=-25 → score -1', async () => {
    mockDp(-25);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(-1);
      expect(r.metadata.decision).toBe('CUT');
    }
  });

  it('Hold: value=0 → score 0', async () => {
    mockDp(0);
    const r = await rateDecisionHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.decision).toBe('HOLD');
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

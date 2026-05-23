import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    dataPoint: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '@core/db/prisma';
import { invertedHandler } from '@core/scoring/handlers/inverted.handler';
import { ScoringContext } from '@core/scoring/types';

const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;

function ctx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    indicatorId: 'ind-1',
    indicatorCode: 'US_UNEMP',
    observationDate: new Date('2026-05-15'),
    ruleVersionId: 'rule-1',
    ruleDefinition: { type: 'inverted', forecast_tolerance_pct: 0.05 },
    ...overrides,
  };
}

function mockDp(overrides: Record<string, unknown> = {}): void {
  mockedFindFirst.mockResolvedValueOnce({
    id: 'dp-1',
    value: 4.0,
    forecastValue: 4.0,
    previousValue: 4.0,
    observationDate: new Date('2026-05-14'),
    ...overrides,
  });
}

describe('invertedHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BEAT (lower): actual=3.8 forecast=4.0 → score +1', async () => {
    mockDp({ value: 3.8, forecastValue: 4.0 });
    const result = await invertedHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(1);
      expect(result.metadata.direction).toBe('BEAT');
    }
  });

  it('MET: actual=4.0 forecast=4.0 → score 0', async () => {
    mockDp({ value: 4.0, forecastValue: 4.0 });
    const result = await invertedHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(0);
      expect(result.metadata.direction).toBe('MET');
    }
  });

  it('MISS (higher): actual=4.2 forecast=4.0 → score -1', async () => {
    mockDp({ value: 4.2, forecastValue: 4.0 });
    const result = await invertedHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(-1);
      expect(result.metadata.direction).toBe('MISS');
    }
  });

  it('Forecast null + previous present → inverted fallback (lower vs previous = BEAT)', async () => {
    mockDp({ value: 3.8, forecastValue: null, previousValue: 4.0 });
    const result = await invertedHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(1);
      expect(result.flags).toContain('USED_PREVIOUS_AS_BASELINE');
      expect(result.metadata.used_previous_as_baseline).toBe(true);
    }
  });

  it('Forecast null + previous null → insufficient_data', async () => {
    mockDp({ value: 4.0, forecastValue: null, previousValue: null });
    const result = await invertedHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
  });

  it('No data point → insufficient_data', async () => {
    mockedFindFirst.mockResolvedValueOnce(null);
    const result = await invertedHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
  });
});

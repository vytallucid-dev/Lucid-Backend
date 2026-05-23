import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    dataPoint: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '@core/db/prisma';
import { normalHandler } from '@core/scoring/handlers/normal.handler';
import { ScoringContext } from '@core/scoring/types';

const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;

function ctx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    indicatorId: 'ind-1',
    indicatorCode: 'US_CPI_YOY',
    observationDate: new Date('2026-05-15'),
    ruleVersionId: 'rule-1',
    ruleDefinition: { type: 'normal', forecast_tolerance_pct: 0.05 },
    ...overrides,
  };
}

function mockDp(overrides: Record<string, unknown> = {}): void {
  mockedFindFirst.mockResolvedValueOnce({
    id: 'dp-1',
    value: 2.5,
    forecastValue: 2.3,
    previousValue: 2.2,
    observationDate: new Date('2026-05-14'),
    ...overrides,
  });
}

describe('normalHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BEAT: actual > forecast + tolerance → score +1', async () => {
    mockDp({ value: 2.5, forecastValue: 2.3 });
    const result = await normalHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(1);
      expect(result.metadata.direction).toBe('BEAT');
    }
  });

  it('MET (exactly equal): actual=2.4 forecast=2.4 → score 0', async () => {
    mockDp({ value: 2.4, forecastValue: 2.4 });
    const result = await normalHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(0);
      expect(result.metadata.direction).toBe('MET');
    }
  });

  it('MET (at tolerance edge): actual=2.45 forecast=2.4 tolerance=0.05 → score 0', async () => {
    mockDp({ value: 2.45, forecastValue: 2.4 });
    const result = await normalHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(0);
      expect(result.metadata.direction).toBe('MET');
    }
  });

  it('MISS: actual < forecast - tolerance → score -1', async () => {
    mockDp({ value: 2.1, forecastValue: 2.4 });
    const result = await normalHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(-1);
      expect(result.metadata.direction).toBe('MISS');
    }
  });

  it('Forecast null + previous present → uses previous as baseline', async () => {
    mockDp({ value: 2.5, forecastValue: null, previousValue: 2.3 });
    const result = await normalHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(1);
      expect(result.flags).toContain('USED_PREVIOUS_AS_BASELINE');
      expect(result.metadata.used_previous_as_baseline).toBe(true);
    }
  });

  it('Forecast null + previous null → insufficient_data', async () => {
    mockDp({ value: 2.5, forecastValue: null, previousValue: null });
    const result = await normalHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
    if (result.kind === 'insufficient_data') {
      expect(result.reason).toMatch(/No forecast and no previous/i);
    }
  });

  it('No data point found → insufficient_data', async () => {
    mockedFindFirst.mockResolvedValueOnce(null);
    const result = await normalHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
  });
});

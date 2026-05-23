import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    dataPoint: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@core/db/prisma';
import { us02ySmaHandler } from '@core/scoring/handlers/us02y-sma.handler';
import { ScoringContext } from '@core/scoring/types';

const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;

function ctx(): ScoringContext {
  return {
    indicatorId: 'ind-1',
    indicatorCode: 'US_02Y_SMA',
    observationDate: new Date('2026-05-15'),
    ruleVersionId: 'rule-1',
    ruleDefinition: { type: 'us02y_sma', flat_band_bp: 1 },
  };
}

function mockTwoDataPoints(todayValue: number | null, yesterdayValue: number | null): void {
  if (todayValue === null) {
    mockedFindFirst.mockResolvedValueOnce(null);
    return;
  }
  mockedFindFirst.mockResolvedValueOnce({
    id: 'dp-today',
    value: todayValue,
    observationDate: new Date('2026-05-15'),
  });
  if (yesterdayValue === null) {
    mockedFindFirst.mockResolvedValueOnce(null);
    return;
  }
  mockedFindFirst.mockResolvedValueOnce({
    id: 'dp-yesterday',
    value: yesterdayValue,
    observationDate: new Date('2026-05-14'),
  });
}

describe('us02ySmaHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Rising: today=4.55 yesterday=4.52 → delta=3bp → score +1', async () => {
    mockTwoDataPoints(4.55, 4.52);
    const r = await us02ySmaHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(1);
      expect(r.metadata.direction).toBe('RISING');
      expect(Number(r.metadata.delta_bp)).toBeCloseTo(3, 5);
    }
  });

  it('Falling: today=4.45 yesterday=4.52 → delta=-7bp → score -1', async () => {
    mockTwoDataPoints(4.45, 4.52);
    const r = await us02ySmaHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(-1);
      expect(r.metadata.direction).toBe('FALLING');
    }
  });

  it('Flat exact: today=4.52 yesterday=4.52 → score 0', async () => {
    mockTwoDataPoints(4.52, 4.52);
    const r = await us02ySmaHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.direction).toBe('FLAT');
    }
  });

  it('Flat within band: today=4.525 yesterday=4.52 → delta=0.5bp → score 0', async () => {
    mockTwoDataPoints(4.525, 4.52);
    const r = await us02ySmaHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.direction).toBe('FLAT');
    }
  });

  it('Today missing → insufficient_data', async () => {
    mockTwoDataPoints(null, null);
    const r = await us02ySmaHandler(ctx());
    expect(r.kind).toBe('insufficient_data');
    if (r.kind === 'insufficient_data') {
      expect(r.reason).toMatch(/No SMA value/);
    }
  });

  it('Yesterday missing → insufficient_data', async () => {
    mockTwoDataPoints(4.5, null);
    const r = await us02ySmaHandler(ctx());
    expect(r.kind).toBe('insufficient_data');
    if (r.kind === 'insufficient_data') {
      expect(r.reason).toMatch(/No prior SMA value/);
    }
  });
});

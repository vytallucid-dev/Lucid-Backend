import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    dataPoint: { findFirst: vi.fn() },
    currencyCycleStance: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@core/db/prisma';
import { cpiRateCycleHandler } from '@core/scoring/handlers/cpi-rate-cycle.handler';
import { ScoringContext } from '@core/scoring/types';

const mockedDp = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedStance = prisma.currencyCycleStance.findFirst as unknown as ReturnType<typeof vi.fn>;

function ctx(currencyCode = 'EUR'): ScoringContext {
  return {
    indicatorId: 'ind-1',
    indicatorCode: `${currencyCode}_CPI_YOY`,
    observationDate: new Date('2026-05-15'),
    ruleVersionId: 'rule-1',
    ruleDefinition: { type: 'cpi_rate_cycle', currency_code: currencyCode },
  };
}

function mockStance(stance: 'CUTTING' | 'NEUTRAL' | 'HIKING'): void {
  mockedStance.mockResolvedValueOnce({
    id: 'stance-1',
    currencyCode: 'EUR',
    stance,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
  });
}

function mockDp(actual: number, forecast: number | null): void {
  mockedDp.mockResolvedValueOnce({
    id: 'dp-1',
    value: actual,
    forecastValue: forecast,
    previousValue: forecast === null ? 2.0 : null,
    observationDate: new Date('2026-05-14'),
  });
}

describe('cpiRateCycleHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // CUTTING: BEAT +1, MET +1, MISS -1
  it('CUTTING + BEAT → +1', async () => {
    mockStance('CUTTING');
    mockDp(2.5, 2.0);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(1);
  });
  it('CUTTING + MET → +1', async () => {
    mockStance('CUTTING');
    mockDp(2.0, 2.0);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(1);
  });
  it('CUTTING + MISS → -1', async () => {
    mockStance('CUTTING');
    mockDp(1.5, 2.0);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(-1);
  });

  // HIKING: BEAT +1, MET +1, MISS 0
  it('HIKING + BEAT → +1', async () => {
    mockStance('HIKING');
    mockDp(2.5, 2.0);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(1);
  });
  it('HIKING + MET → +1', async () => {
    mockStance('HIKING');
    mockDp(2.0, 2.0);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(1);
  });
  it('HIKING + MISS → 0', async () => {
    mockStance('HIKING');
    mockDp(1.5, 2.0);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(0);
  });

  // NEUTRAL: BEAT +1, MET 0, MISS -1
  it('NEUTRAL + BEAT → +1', async () => {
    mockStance('NEUTRAL');
    mockDp(2.5, 2.0);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(1);
  });
  it('NEUTRAL + MET → 0', async () => {
    mockStance('NEUTRAL');
    mockDp(2.0, 2.0);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(0);
  });
  it('NEUTRAL + MISS → -1', async () => {
    mockStance('NEUTRAL');
    mockDp(1.5, 2.0);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(-1);
  });

  it('No active stance → insufficient_data', async () => {
    mockedStance.mockResolvedValueOnce(null);
    const r = await cpiRateCycleHandler(ctx());
    expect(r.kind).toBe('insufficient_data');
    if (r.kind === 'insufficient_data') {
      expect(r.reason).toMatch(/No active cycle stance/);
    }
  });
});

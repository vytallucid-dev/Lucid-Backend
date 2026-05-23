import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    asset: { findUnique: vi.fn() },
    cotData: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@core/db/prisma';
import { cotTwoComponentHandler } from '@core/scoring/handlers/cot/cot-two-component.handler';
import { ScoringContext } from '@core/scoring/types';

const mockedAssetFindUnique = prisma.asset.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedCotFindFirst = prisma.cotData.findFirst as unknown as ReturnType<typeof vi.fn>;

function ctx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    indicatorId: 'ind-usd-cot',
    indicatorCode: 'USD_COT',
    observationDate: new Date('2026-05-15'),
    ruleVersionId: 'rule-1',
    ruleDefinition: { type: 'cot_two_component', asset_code: 'USD' },
    ...overrides,
  };
}

function mockAssetOk(): void {
  mockedAssetFindUnique.mockResolvedValue({
    id: 'asset-usd',
    code: 'USD',
    metadata: {
      cotContractCode: '098662',
      cotTraderCategory: 'Large Speculators',
    },
  });
}

function mockCotRow(longPct: number | null, weeklyChangePct: number | null): void {
  mockedCotFindFirst.mockResolvedValue({
    id: 'cot-1',
    contractCode: '098662',
    traderCategory: 'Large Speculators',
    reportDate: new Date('2026-05-13'),
    longPct,
    weeklyChangePct,
    isCurrent: true,
  });
}

describe('cotTwoComponentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Bullish + Bullish → +2', async () => {
    mockAssetOk();
    mockCotRow(67.5, 2.5);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(2);
      expect(result.metadata.netLabel).toBe('Bullish');
      expect(result.metadata.changeLabel).toBe('Bullish');
      expect(result.metadata.longPct).toBe(67.5);
      expect(result.metadata.weeklyChangePct).toBe(2.5);
      expect(result.metadata.contractCode).toBe('098662');
      expect(result.metadata.traderCategory).toBe('Large Speculators');
      expect(result.metadata.reportDate).toBe('2026-05-13');
      expect(result.metadata.assetCode).toBe('USD');
    }
  });

  it('Bearish + Bearish → -2', async () => {
    mockAssetOk();
    mockCotRow(30, -2);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(-2);
      expect(result.metadata.netLabel).toBe('Bearish');
      expect(result.metadata.changeLabel).toBe('Bearish');
    }
  });

  it('Neutral + Bullish → +1', async () => {
    mockAssetOk();
    mockCotRow(50, 1.0);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(1);
      expect(result.metadata.netLabel).toBe('Neutral');
      expect(result.metadata.changeLabel).toBe('Bullish');
    }
  });

  it('Bullish + Bearish → 0', async () => {
    mockAssetOk();
    mockCotRow(60, -1);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(0);
      expect(result.metadata.netLabel).toBe('Bullish');
      expect(result.metadata.changeLabel).toBe('Bearish');
    }
  });

  it('Bearish + Bullish → 0', async () => {
    mockAssetOk();
    mockCotRow(40, 1);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('scored');
    if (result.kind === 'scored') {
      expect(result.score).toBe(0);
    }
  });

  it('null longPct → insufficient_data', async () => {
    mockAssetOk();
    mockCotRow(null, 1.0);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
    if (result.kind === 'insufficient_data') {
      expect(result.details?.longPctNull).toBe(true);
    }
  });

  it('null weeklyChangePct → insufficient_data', async () => {
    mockAssetOk();
    mockCotRow(60, null);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
    if (result.kind === 'insufficient_data') {
      expect(result.details?.weeklyChangePctNull).toBe(true);
    }
  });

  it('both nulls → insufficient_data', async () => {
    mockAssetOk();
    mockCotRow(null, null);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
  });

  it('no COT data row → insufficient_data', async () => {
    mockAssetOk();
    mockedCotFindFirst.mockResolvedValue(null);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
    if (result.kind === 'insufficient_data') {
      expect(result.reason).toMatch(/No COT data/);
    }
  });

  it('asset not found → insufficient_data', async () => {
    mockedAssetFindUnique.mockResolvedValue(null);
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
    if (result.kind === 'insufficient_data') {
      expect(result.reason).toMatch(/not found/);
    }
  });

  it('asset metadata missing cotContractCode → insufficient_data', async () => {
    mockedAssetFindUnique.mockResolvedValue({
      id: 'asset-x',
      code: 'USD',
      metadata: { cotTraderCategory: 'Large Speculators' },
    });
    const result = await cotTwoComponentHandler(ctx());
    expect(result.kind).toBe('insufficient_data');
    if (result.kind === 'insufficient_data') {
      expect(result.reason).toMatch(/cotContractCode/);
    }
  });

  it('rule definition missing asset_code → insufficient_data', async () => {
    const result = await cotTwoComponentHandler(
      ctx({ ruleDefinition: { type: 'cot_two_component' } }),
    );
    expect(result.kind).toBe('insufficient_data');
    if (result.kind === 'insufficient_data') {
      expect(result.reason).toMatch(/asset_code/);
    }
  });

  it('queries cotData with contractCode + traderCategory + isCurrent', async () => {
    mockAssetOk();
    mockCotRow(60, 1);
    await cotTwoComponentHandler(ctx());
    const call = mockedCotFindFirst.mock.calls[0][0];
    expect(call.where.contractCode).toBe('098662');
    expect(call.where.traderCategory).toBe('Large Speculators');
    expect(call.where.isCurrent).toBe(true);
    expect(call.orderBy.reportDate).toBe('desc');
  });
});

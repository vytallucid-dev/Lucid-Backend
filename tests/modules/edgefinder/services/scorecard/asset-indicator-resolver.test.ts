import { vi, describe, it, expect, beforeEach } from 'vitest';

type IndicatorRow = {
  id: string;
  code: string;
  country: string;
  uiGroup: string | null;
  tool: string;
  isActive: boolean;
};

type AssetRow = { id: string; code: string };

const fixtures: { indicators: IndicatorRow[]; assets: AssetRow[] } = {
  indicators: [],
  assets: [],
};

vi.mock('@core/db/prisma', () => ({
  prisma: {
    asset: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) => {
        return fixtures.assets.find((a) => a.code === where.code) ?? null;
      }),
    },
    indicator: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            tool: string;
            isActive: boolean;
            country: { in: string[] };
          };
        }) => {
          return fixtures.indicators.filter(
            (i) =>
              i.tool === where.tool &&
              i.isActive === where.isActive &&
              where.country.in.includes(i.country),
          );
        },
      ),
    },
  },
}));

import { resolveAssetIndicators } from '@modules/edgefinder/services/scorecard/asset-indicator-resolver';

beforeEach(() => {
  fixtures.indicators = [];
  fixtures.assets = [];
});

function seedDefaultAssets(): void {
  fixtures.assets = [
    { id: 'asset-usd', code: 'USD' },
    { id: 'asset-eur', code: 'EUR' },
    { id: 'asset-gbp', code: 'GBP' },
    { id: 'asset-jpy', code: 'JPY' },
    { id: 'asset-xau', code: 'XAUUSD' },
  ];
}

function seedDefaultIndicators(): void {
  fixtures.indicators = [
    { id: 'i-us-gdp', code: 'US_GDP_QOQ', country: 'US', uiGroup: 'Growth', tool: 'edgefinder', isActive: true },
    { id: 'i-us-cpi', code: 'US_CPI_YOY', country: 'US', uiGroup: 'Inflation', tool: 'edgefinder', isActive: true },
    { id: 'i-us-jc',  code: 'US_JOBLESS_CLAIMS', country: 'US', uiGroup: 'Jobs', tool: 'edgefinder', isActive: true },
    { id: 'i-us-rate',code: 'US_FED_RATE', country: 'US', uiGroup: 'Rates', tool: 'edgefinder', isActive: true },
    { id: 'i-usd-cot',code: 'USD_COT', country: 'USD', uiGroup: 'COT', tool: 'edgefinder', isActive: true },
    { id: 'i-eu-gdp', code: 'EU_GDP_QOQ', country: 'EU', uiGroup: 'Growth', tool: 'edgefinder', isActive: true },
    { id: 'i-eur-cot',code: 'EUR_COT', country: 'EUR', uiGroup: 'COT', tool: 'edgefinder', isActive: true },
    { id: 'i-uk-gdp', code: 'UK_GDP_MOM', country: 'UK', uiGroup: 'Growth', tool: 'edgefinder', isActive: true },
    { id: 'i-gbp-cot',code: 'GBP_COT', country: 'GBP', uiGroup: 'COT', tool: 'edgefinder', isActive: true },
    { id: 'i-jp-gdp', code: 'JP_GDP_QOQ', country: 'JP', uiGroup: 'Growth', tool: 'edgefinder', isActive: true },
    { id: 'i-jpy-cot',code: 'JPY_COT', country: 'JPY', uiGroup: 'COT', tool: 'edgefinder', isActive: true },
    { id: 'i-xau-cot',code: 'XAUUSD_COT', country: 'XAU', uiGroup: 'COT', tool: 'edgefinder', isActive: true },
  ];
}

describe('resolveAssetIndicators', () => {
  it('USD → US fundamentals + USD_COT', async () => {
    seedDefaultAssets();
    seedDefaultIndicators();
    const r = await resolveAssetIndicators('USD');
    expect(r.assetCode).toBe('USD');
    expect(r.assetId).toBe('asset-usd');
    const codes = r.indicators.map((i) => i.indicatorCode).sort();
    expect(codes).toEqual(['USD_COT', 'US_CPI_YOY', 'US_FED_RATE', 'US_GDP_QOQ', 'US_JOBLESS_CLAIMS']);
    const cot = r.indicators.find((i) => i.indicatorCode === 'USD_COT');
    expect(cot?.isCot).toBe(true);
    expect(cot?.category).toBe('COT');
    expect(r.indicators.every((i) => i.flipScoreForGold === false)).toBe(true);
  });

  it('EUR → EU fundamentals + EUR_COT only', async () => {
    seedDefaultAssets();
    seedDefaultIndicators();
    const r = await resolveAssetIndicators('EUR');
    const codes = r.indicators.map((i) => i.indicatorCode).sort();
    expect(codes).toEqual(['EUR_COT', 'EU_GDP_QOQ']);
  });

  it('XAUUSD → US fundamentals (flipped) + XAUUSD_COT (not flipped) + jobless claims (not flipped)', async () => {
    seedDefaultAssets();
    seedDefaultIndicators();
    const r = await resolveAssetIndicators('XAUUSD');
    const codes = r.indicators.map((i) => i.indicatorCode).sort();
    expect(codes).toEqual([
      'US_CPI_YOY',
      'US_FED_RATE',
      'US_GDP_QOQ',
      'US_JOBLESS_CLAIMS',
      'XAUUSD_COT',
    ]);
    expect(r.indicators.find((i) => i.indicatorCode === 'US_CPI_YOY')?.flipScoreForGold).toBe(true);
    expect(r.indicators.find((i) => i.indicatorCode === 'US_GDP_QOQ')?.flipScoreForGold).toBe(true);
    expect(r.indicators.find((i) => i.indicatorCode === 'US_FED_RATE')?.flipScoreForGold).toBe(true);
    expect(r.indicators.find((i) => i.indicatorCode === 'US_JOBLESS_CLAIMS')?.flipScoreForGold).toBe(false);
    expect(r.indicators.find((i) => i.indicatorCode === 'XAUUSD_COT')?.flipScoreForGold).toBe(false);
    expect(r.indicators.find((i) => i.indicatorCode === 'XAUUSD_COT')?.isCot).toBe(true);
  });

  it('JPY → JP fundamentals + JPY_COT', async () => {
    seedDefaultAssets();
    seedDefaultIndicators();
    const r = await resolveAssetIndicators('JPY');
    const codes = r.indicators.map((i) => i.indicatorCode).sort();
    expect(codes).toEqual(['JPY_COT', 'JP_GDP_QOQ']);
  });

  it('Unknown asset → throws', async () => {
    seedDefaultAssets();
    await expect(resolveAssetIndicators('XYZ')).rejects.toThrow(/No indicator mapping/);
  });

  it('Asset code with mapping but not seeded → throws', async () => {
    seedDefaultIndicators();
    await expect(resolveAssetIndicators('USD')).rejects.toThrow(/Asset not found/);
  });
});

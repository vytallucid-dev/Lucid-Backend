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

type MapRow = {
  assetId: string;
  indicatorId: string;
  polarity: number;
  isCot: boolean;
};

const fixtures: { indicators: IndicatorRow[]; assets: AssetRow[]; maps: MapRow[] } = {
  indicators: [],
  assets: [],
  maps: [],
};

/**
 * Phase 2: membership, COT identification and sign all come from
 * asset_indicator_map. The mock mirrors the real query: filter by assetId, join
 * the indicator, drop inactive/non-EdgeFinder indicators, and order by
 * uiGroup ASC then code ASC (which the persisted breakdown ordering depends on).
 */
vi.mock('@core/db/prisma', () => ({
  prisma: {
    asset: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) => {
        return fixtures.assets.find((a) => a.code === where.code) ?? null;
      }),
    },
    assetIndicatorMap: {
      findMany: vi.fn(async ({ where }: { where: { assetId: string } }) => {
        return fixtures.maps
          .filter((m) => m.assetId === where.assetId)
          .map((m) => ({
            ...m,
            indicator: fixtures.indicators.find((i) => i.id === m.indicatorId)!,
          }))
          .filter((m) => m.indicator && m.indicator.tool === 'edgefinder' && m.indicator.isActive)
          .sort(
            (a, b) =>
              (a.indicator.uiGroup ?? '').localeCompare(b.indicator.uiGroup ?? '') ||
              a.indicator.code.localeCompare(b.indicator.code),
          );
      }),
    },
  },
}));

import { resolveAssetIndicators } from '@modules/edgefinder/services/scorecard/asset-indicator-resolver';

beforeEach(() => {
  fixtures.indicators = [];
  fixtures.assets = [];
  fixtures.maps = [];
});

function seedDefaultAssets(): void {
  fixtures.assets = [
    { id: 'asset-usd', code: 'USD' },
    { id: 'asset-eur', code: 'EUR' },
    { id: 'asset-gbp', code: 'GBP' },
    { id: 'asset-jpy', code: 'JPY' },
    { id: 'asset-xau', code: 'XAUUSD' },
    { id: 'asset-dxy', code: 'DXY' },
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

/** Mirrors the Phase 1 backfill: currencies +1, Gold -1 on every non-COT row. */
function seedDefaultMaps(): void {
  const usFundamentals = ['i-us-gdp', 'i-us-cpi', 'i-us-jc', 'i-us-rate'];
  fixtures.maps = [
    ...usFundamentals.map((indicatorId) => ({ assetId: 'asset-usd', indicatorId, polarity: 1, isCot: false })),
    { assetId: 'asset-usd', indicatorId: 'i-usd-cot', polarity: 1, isCot: true },

    { assetId: 'asset-eur', indicatorId: 'i-eu-gdp', polarity: 1, isCot: false },
    { assetId: 'asset-eur', indicatorId: 'i-eur-cot', polarity: 1, isCot: true },

    { assetId: 'asset-gbp', indicatorId: 'i-uk-gdp', polarity: 1, isCot: false },
    { assetId: 'asset-gbp', indicatorId: 'i-gbp-cot', polarity: 1, isCot: true },

    { assetId: 'asset-jpy', indicatorId: 'i-jp-gdp', polarity: 1, isCot: false },
    { assetId: 'asset-jpy', indicatorId: 'i-jpy-cot', polarity: 1, isCot: true },

    ...usFundamentals.map((indicatorId) => ({ assetId: 'asset-xau', indicatorId, polarity: -1, isCot: false })),
    { assetId: 'asset-xau', indicatorId: 'i-xau-cot', polarity: 1, isCot: true },
  ];
}

function seedAll(): void {
  seedDefaultAssets();
  seedDefaultIndicators();
  seedDefaultMaps();
}

describe('resolveAssetIndicators', () => {
  it('USD → US fundamentals + USD_COT, all polarity +1', async () => {
    seedAll();
    const r = await resolveAssetIndicators('USD');
    expect(r.assetCode).toBe('USD');
    expect(r.assetId).toBe('asset-usd');
    const codes = r.indicators.map((i) => i.indicatorCode).sort();
    expect(codes).toEqual(['USD_COT', 'US_CPI_YOY', 'US_FED_RATE', 'US_GDP_QOQ', 'US_JOBLESS_CLAIMS']);
    const cot = r.indicators.find((i) => i.indicatorCode === 'USD_COT');
    expect(cot?.isCot).toBe(true);
    expect(cot?.category).toBe('COT');
    expect(r.indicators.every((i) => i.polarity === 1)).toBe(true);
    expect(r.indicators.every((i) => i.flipScoreForGold === false)).toBe(true);
  });

  it('EUR → EU fundamentals + EUR_COT only', async () => {
    seedAll();
    const r = await resolveAssetIndicators('EUR');
    const codes = r.indicators.map((i) => i.indicatorCode).sort();
    expect(codes).toEqual(['EUR_COT', 'EU_GDP_QOQ']);
  });

  it('XAUUSD → every non-COT indicator at polarity -1, COT stays +1', async () => {
    seedAll();
    const r = await resolveAssetIndicators('XAUUSD');
    const codes = r.indicators.map((i) => i.indicatorCode).sort();
    expect(codes).toEqual([
      'US_CPI_YOY',
      'US_FED_RATE',
      'US_GDP_QOQ',
      'US_JOBLESS_CLAIMS',
      'XAUUSD_COT',
    ]);
    for (const code of ['US_CPI_YOY', 'US_GDP_QOQ', 'US_FED_RATE', 'US_JOBLESS_CLAIMS']) {
      expect(r.indicators.find((i) => i.indicatorCode === code)?.polarity, code).toBe(-1);
      // Legacy derived field, still emitted into indicatorBreakdown.
      expect(r.indicators.find((i) => i.indicatorCode === code)?.flipScoreForGold, code).toBe(true);
    }
    const cot = r.indicators.find((i) => i.indicatorCode === 'XAUUSD_COT');
    expect(cot?.polarity).toBe(1);
    expect(cot?.flipScoreForGold).toBe(false);
    expect(cot?.isCot).toBe(true);
  });

  it('supports mixed polarity within one asset (what a single boolean could not express)', async () => {
    seedAll();
    fixtures.assets.push({ id: 'asset-spy', code: 'SPY' });
    fixtures.maps.push(
      { assetId: 'asset-spy', indicatorId: 'i-us-gdp', polarity: 1, isCot: false },
      { assetId: 'asset-spy', indicatorId: 'i-us-cpi', polarity: -1, isCot: false },
    );
    const r = await resolveAssetIndicators('SPY');
    expect(r.indicators.find((i) => i.indicatorCode === 'US_GDP_QOQ')?.polarity).toBe(1);
    expect(r.indicators.find((i) => i.indicatorCode === 'US_CPI_YOY')?.polarity).toBe(-1);
  });

  it('orders by uiGroup then code so the persisted breakdown stays stable', async () => {
    seedAll();
    const r = await resolveAssetIndicators('USD');
    expect(r.indicators.map((i) => i.indicatorCode)).toEqual([
      'USD_COT', // COT
      'US_GDP_QOQ', // Growth
      'US_CPI_YOY', // Inflation
      'US_JOBLESS_CLAIMS', // Jobs
      'US_FED_RATE', // Rates
    ]);
  });

  it('inactive indicators are excluded from the map result', async () => {
    seedAll();
    fixtures.indicators.find((i) => i.id === 'i-us-cpi')!.isActive = false;
    const r = await resolveAssetIndicators('USD');
    expect(r.indicators.map((i) => i.indicatorCode)).not.toContain('US_CPI_YOY');
  });

  it('asset with NO map rows throws a clear, named error rather than scoring 0', async () => {
    seedAll(); // DXY exists as an asset but has no map rows
    await expect(resolveAssetIndicators('DXY')).rejects.toThrow(
      /No indicator map rows for asset code: DXY/,
    );
  });

  it('Asset that does not exist → throws', async () => {
    seedAll();
    await expect(resolveAssetIndicators('XYZ')).rejects.toThrow(/Asset not found/);
  });
});

/// <reference types="node" />
/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seedAssets(): Promise<void> {
  const assets = [
    { code: 'NIFTY', name: 'NIFTY 50', assetClass: 'index' as const, toolScope: ['nifty'] },
    { code: 'EURUSD', name: 'EUR/USD', assetClass: 'forex_pair' as const, toolScope: ['edgefinder'] },
    { code: 'GBPUSD', name: 'GBP/USD', assetClass: 'forex_pair' as const, toolScope: ['edgefinder'] },
    { code: 'USDJPY', name: 'USD/JPY', assetClass: 'forex_pair' as const, toolScope: ['edgefinder'] },
    { code: 'EURJPY', name: 'EUR/JPY', assetClass: 'forex_pair' as const, toolScope: ['edgefinder'] },
    { code: 'GBPJPY', name: 'GBP/JPY', assetClass: 'forex_pair' as const, toolScope: ['edgefinder'] },
    { code: 'XAUUSD', name: 'Gold', assetClass: 'commodity' as const, toolScope: ['edgefinder', 'nifty'] },
    { code: 'SPY', name: 'S&P 500 ETF', assetClass: 'equity' as const, toolScope: ['edgefinder'] },
    { code: 'NAS100', name: 'NASDAQ 100', assetClass: 'index' as const, toolScope: ['edgefinder'] },
    { code: 'DXY', name: 'US Dollar Index', assetClass: 'index' as const, toolScope: ['nifty', 'edgefinder'] },
  ];

  for (const a of assets) {
    await prisma.asset.upsert({
      where: { code: a.code },
      update: {},
      create: a,
    });
  }
  console.log(`✅ Seeded ${assets.length} assets`);
}

async function seedIndicators(): Promise<void> {
  const indicators = [
    {
      code: 'IND_NIFTY_01_PMI_MFG',
      name: 'India PMI Manufacturing',
      category: 'domestic' as const,
      tool: 'nifty' as const,
      frequency: 'monthly' as const,
      unit: 'index_pts',
      dataSource: 'manual' as const,
      displayOrder: 1,
      compositeGroup: 'domestic' as const,
    },
    {
      code: 'IND_NIFTY_02_PMI_SVC',
      name: 'India PMI Services',
      category: 'domestic' as const,
      tool: 'nifty' as const,
      frequency: 'monthly' as const,
      unit: 'index_pts',
      dataSource: 'manual' as const,
      displayOrder: 2,
      compositeGroup: 'domestic' as const,
    },
    {
      code: 'IND_NIFTY_03_CPI',
      name: 'India CPI YoY',
      category: 'domestic' as const,
      tool: 'nifty' as const,
      frequency: 'monthly' as const,
      unit: '%',
      dataSource: 'fred' as const,
      sourceSeriesId: 'INDCPIALLMINMEI',
      displayOrder: 3,
      compositeGroup: 'domestic' as const,
    },
    {
      code: 'IND_NIFTY_04_RBI_RATE',
      name: 'RBI Repo Rate Direction',
      category: 'domestic' as const,
      tool: 'nifty' as const,
      frequency: 'event_driven' as const,
      unit: '%',
      dataSource: 'manual' as const,
      displayOrder: 4,
      compositeGroup: 'domestic' as const,
    },
    {
      code: 'IND_NIFTY_05_IIP',
      name: 'India Industrial Production',
      category: 'domestic' as const,
      tool: 'nifty' as const,
      frequency: 'monthly' as const,
      unit: '%',
      dataSource: 'fred' as const,
      sourceSeriesId: 'INDPROINDMISMEI',
      displayOrder: 5,
      compositeGroup: 'domestic' as const,
    },
    {
      code: 'IND_NIFTY_06_FII_FLOW',
      name: 'FII 10-day Rolling Cash Flow',
      category: 'flow' as const,
      tool: 'nifty' as const,
      frequency: 'daily' as const,
      unit: 'INR_crore',
      dataSource: 'nse_scrape' as const,
      displayOrder: 6,
      compositeGroup: 'domestic' as const,
    },
    {
      code: 'IND_NIFTY_07_DII_ABSORPTION',
      name: 'DII Absorption Ratio',
      category: 'flow' as const,
      tool: 'nifty' as const,
      frequency: 'daily' as const,
      unit: 'ratio',
      dataSource: 'derived' as const,
      displayOrder: 7,
      compositeGroup: 'domestic' as const,
    },
    {
      code: 'IND_NIFTY_08_VIX',
      name: 'India VIX',
      category: 'sentiment' as const,
      tool: 'nifty' as const,
      frequency: 'daily' as const,
      unit: 'index_pts',
      dataSource: 'nse_scrape' as const,
      displayOrder: 8,
      compositeGroup: 'external' as const,
    },
    {
      code: 'IND_NIFTY_09_USD_WEAKNESS',
      name: 'USD Weakness (NIFTY-facing)',
      category: 'global' as const,
      tool: 'nifty' as const,
      frequency: 'daily' as const,
      unit: 'score',
      dataSource: 'derived' as const,
      displayOrder: 9,
      compositeGroup: 'external' as const,
    },
    {
      code: 'IND_NIFTY_10_DXY',
      name: 'DXY 10-day Direction',
      category: 'global' as const,
      tool: 'nifty' as const,
      frequency: 'daily' as const,
      unit: 'index_pts',
      // Migrated from FRED (DTWEXBGS, broad-index ~118 scale) to EODHD ICE DXY
      // (DXY.INDX, ~98 scale). See migration *_nifty_price_indicators_to_eodhd.
      dataSource: 'eodhd' as const,
      sourceSeriesId: 'DXY.INDX',
      displayOrder: 10,
      compositeGroup: 'external' as const,
    },
    {
      code: 'IND_NIFTY_11_BRENT',
      name: 'Brent Crude 10-day Direction',
      category: 'global' as const,
      tool: 'nifty' as const,
      frequency: 'daily' as const,
      unit: 'USD_per_barrel',
      // Migrated from FRED (DCOILBRENTEU) to EODHD commodities endpoint (BRENT).
      dataSource: 'eodhd' as const,
      sourceSeriesId: 'BRENT',
      displayOrder: 11,
      compositeGroup: 'external' as const,
    },
    {
      code: 'IND_NIFTY_12_USDINR',
      name: 'USD/INR 10-day Direction',
      category: 'india_specific' as const,
      tool: 'nifty' as const,
      frequency: 'daily' as const,
      unit: 'INR_per_USD',
      // Migrated from FRED (DEXINUS) to EODHD forex endpoint (USDINR.FOREX).
      dataSource: 'eodhd' as const,
      sourceSeriesId: 'USDINR.FOREX',
      displayOrder: 12,
      compositeGroup: 'external' as const,
    },
    {
      code: 'IND_NIFTY_13_FII_LS_RATIO',
      name: 'FII Long/Short Ratio (Futures)',
      category: 'flow' as const,
      tool: 'nifty' as const,
      frequency: 'daily' as const,
      unit: '%',
      dataSource: 'nse_scrape' as const,
      displayOrder: 13,
      compositeGroup: 'external' as const,
    },
  ];

  for (const ind of indicators) {
    await prisma.indicator.upsert({
      where: { code: ind.code },
      update: {},
      create: ind,
    });
  }
  console.log(`✅ Seeded ${indicators.length} NIFTY indicators`);
}

async function seedScoringRules(): Promise<void> {
  const indicatorCodes = await prisma.indicator.findMany({
    where: { tool: 'nifty' },
    select: { id: true, code: true },
  });

  const ruleMap: Record<string, { ruleType: 'threshold' | 'direction' | 'band' | 'custom'; ruleDefinition: object }> = {
    IND_NIFTY_01_PMI_MFG: {
      ruleType: 'threshold',
      ruleDefinition: {
        type: 'threshold_with_direction',
        positive_if: 'value >= 50 AND value >= previous_value',
        negative_if: 'value < 50',
        neutral_otherwise: true,
      },
    },
    IND_NIFTY_02_PMI_SVC: {
      ruleType: 'threshold',
      ruleDefinition: {
        type: 'threshold_with_direction',
        positive_if: 'value >= 50 AND value >= previous_value',
        negative_if: 'value < 50',
        neutral_otherwise: true,
      },
    },
    IND_NIFTY_03_CPI: {
      ruleType: 'band',
      ruleDefinition: {
        type: 'band',
        positive_if: 'value <= 6 AND falling',
        negative_if: 'value > 6 AND rising',
        neutral_otherwise: true,
        note: 'India CPI band ceiling = 6%',
      },
    },
    IND_NIFTY_04_RBI_RATE: {
      ruleType: 'custom',
      ruleDefinition: {
        type: 'rate_direction',
        positive_if: 'cutting OR paused_after_hikes',
        negative_if: 'hiking',
        neutral_otherwise: true,
      },
    },
    IND_NIFTY_05_IIP: {
      ruleType: 'direction',
      ruleDefinition: {
        type: 'direction',
        positive_if: 'value > 0 AND value >= previous_value',
        negative_if: 'value < 0',
        neutral_otherwise: true,
      },
    },
    IND_NIFTY_06_FII_FLOW: {
      ruleType: 'direction',
      ruleDefinition: {
        type: 'rolling_direction',
        lookback_days: 10,
        metric: 'rolling_avg',
        positive_if: 'rolling_avg > 0 AND improving',
        negative_if: 'rolling_avg < 0 AND worsening',
        neutral_otherwise: true,
      },
    },
    IND_NIFTY_07_DII_ABSORPTION: {
      ruleType: 'threshold',
      ruleDefinition: {
        type: 'threshold',
        formula: 'dii_buy / abs(fii_sell)',
        positive_if: 'ratio >= 0.75',
        negative_if: 'ratio < 0.25',
        neutral_otherwise: true,
      },
    },
    IND_NIFTY_08_VIX: {
      ruleType: 'band',
      ruleDefinition: {
        type: 'band',
        bands: [
          { min: null, max: 12, score: 1 },
          { min: 12, max: 15, score: 0 },
          { min: 15, max: 20, score: -1 },
          { min: 20, max: null, score: -1, flag: 'contrarian_watch' },
        ],
      },
    },
    IND_NIFTY_09_USD_WEAKNESS: {
      ruleType: 'threshold',
      ruleDefinition: {
        type: 'derived_threshold',
        source: 'sum_of_14_us_indicator_scores',
        positive_if: 'raw_sum <= -4',
        negative_if: 'raw_sum >= 4',
        neutral_otherwise: true,
        note: 'USD weak = bullish NIFTY; USD strong = bearish NIFTY',
      },
    },
    IND_NIFTY_10_DXY: {
      ruleType: 'direction',
      ruleDefinition: {
        type: 'direction',
        lookback_days: 10,
        metric: 'pct_change_10d',
        positive_if: 'pct_change < 0',
        negative_if: 'pct_change > 0',
        neutral_band: [-0.3, 0.3],
      },
    },
    IND_NIFTY_11_BRENT: {
      ruleType: 'direction',
      ruleDefinition: {
        type: 'direction',
        lookback_days: 10,
        metric: 'pct_change_10d',
        positive_if: 'pct_change < 0',
        negative_if: 'pct_change > 0',
        neutral_band: [-0.5, 0.5],
        note: 'Falling crude = lower import bill = bullish India',
      },
    },
    IND_NIFTY_12_USDINR: {
      ruleType: 'direction',
      ruleDefinition: {
        type: 'direction',
        lookback_days: 10,
        metric: 'pct_change_10d',
        positive_if: 'pct_change < 0',
        negative_if: 'pct_change > 0',
        neutral_band: [-0.3, 0.3],
        note: 'INR strengthening = bullish NIFTY',
      },
    },
    IND_NIFTY_13_FII_LS_RATIO: {
      ruleType: 'threshold',
      ruleDefinition: {
        type: 'threshold_with_direction',
        positive_if: 'long_pct > 50 OR rising',
        negative_if: 'long_pct < 40 OR falling',
        neutral_otherwise: true,
        note: 'NSE Participant OI data; backfill gap exists',
      },
    },
  };

  let count = 0;
  for (const ind of indicatorCodes) {
    const rule = ruleMap[ind.code];
    if (!rule) continue;

    await prisma.scoringRule.upsert({
      where: { indicatorId_version: { indicatorId: ind.id, version: 1 } },
      update: {},
      create: {
        indicatorId: ind.id,
        version: 1,
        ruleType: rule.ruleType,
        ruleDefinition: rule.ruleDefinition,
        effectiveFrom: new Date('2026-01-01'),
        notes: 'v1 — derived from Lucid NIFTY Master Doc v9, locked April 2026',
      },
    });
    count++;
  }
  console.log(`✅ Seeded ${count} v1 scoring rules`);
}

async function seedScorecardRatingRules(): Promise<void> {
  await prisma.scorecardRatingRule.upsert({
    where: { tool_version: { tool: 'nifty', version: 1 } },
    update: {},
    create: {
      tool: 'nifty',
      version: 1,
      rules: {
        ranges: [
          { min: 7, max: 13, label: 'Strong Bullish' },
          { min: 3, max: 6, label: 'Bullish' },
          { min: -2, max: 2, label: 'Neutral' },
          { min: -6, max: -3, label: 'Bearish' },
          { min: -13, max: -7, label: 'Strong Bearish' },
        ],
        special_flags: [
          {
            name: 'clean_bullish',
            condition: { negative_count: 0, net_min: 5 },
          },
          {
            name: 'clean_bearish',
            condition: { positive_count: 0, net_max: -5 },
          },
        ],
      },
      effectiveFrom: new Date('2026-01-01'),
    },
  });
  console.log('✅ Seeded NIFTY scorecard rating rules v1');
}

async function main(): Promise<void> {
  console.log('🌱 Starting seed...');
  await seedAssets();
  await seedIndicators();
  await seedScoringRules();
  await seedScorecardRatingRules();
  console.log('✅ Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

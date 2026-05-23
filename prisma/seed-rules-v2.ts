/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const V1_END_DATE = new Date('2026-05-16');
const V2_START_DATE = new Date('2026-05-17');

const SCORING_RULES_V2: Record<
  string,
  { ruleType: 'threshold' | 'direction' | 'band' | 'custom'; ruleDefinition: object }
> = {
  IND_NIFTY_01_PMI_MFG: {
    ruleType: 'threshold',
    ruleDefinition: {
      type: 'threshold',
      reference: 50.0,
      gt: 1,
      eq: 0,
      lt: -1,
      strictness: 'strict_numeric',
      cadence: 'monthly',
    },
  },
  IND_NIFTY_02_PMI_SVC: {
    ruleType: 'threshold',
    ruleDefinition: {
      type: 'threshold',
      reference: 50.0,
      gt: 1,
      eq: 0,
      lt: -1,
      strictness: 'strict_numeric',
      cadence: 'monthly',
    },
  },
  IND_NIFTY_03_CPI: {
    ruleType: 'custom',
    ruleDefinition: {
      type: 'two_component_cpi',
      threshold: {
        rbi_band_upper: 6.0,
        well_below: 4.0,
        comment: 'CPI <= 4 -> +1; 4 < CPI <= 6 -> 0; CPI > 6 -> -1',
      },
      trajectory: {
        lookback_months: 3,
        bps_threshold: 20,
        comment: 'current - 3mo avg, +/-20bps band',
      },
      bounds: { min: -2, max: 2 },
      cadence: 'monthly',
    },
  },
  IND_NIFTY_04_RBI_RATE: {
    ruleType: 'custom',
    ruleDefinition: {
      type: 'cycle_regime',
      states: {
        cutting: 1,
        paused_after_hikes: 1,
        hold_neutral: 0,
        hiking: -1,
        hawkish_hold: 0,
      },
      saturation: 'P15-7',
      cadence: 'event_driven',
      note: 'Score persists from last MPC until next. Cycle state stored in data_point metadata.',
    },
  },
  IND_NIFTY_05_IIP: {
    ruleType: 'threshold',
    ruleDefinition: {
      type: 'threshold',
      reference: 0.0,
      gt: 1,
      eq: 0,
      lt: -1,
      strictness: 'strict_numeric',
      cadence: 'monthly',
    },
  },
  IND_NIFTY_06_FII_FLOW: {
    ruleType: 'custom',
    ruleDefinition: {
      type: 'rolling_tiered',
      lookback_trading_days: 10,
      metric: 'rolling_avg_inr_crore',
      tiers: [
        { min: 4000, max: null, score: 2 },
        { min: 1500, max: 4000, score: 1 },
        { min: -1500, max: 1500, score: 0 },
        { min: -4000, max: -1500, score: -1 },
        { min: null, max: -4000, score: -2 },
      ],
      cadence: 'daily',
    },
  },
  IND_NIFTY_07_DII_ABSORPTION: {
    ruleType: 'custom',
    ruleDefinition: {
      type: 'rolling_ratio_excluding',
      lookback_trading_days: 5,
      exclusion: 'fii_net_buyer_days',
      tiers: [
        { min: 0.75, max: null, score: 1 },
        { min: 0.5, max: 0.75, score: 0 },
        { min: null, max: 0.5, score: -1 },
      ],
      all_excluded_fallback: { score: 0, flag: 'FII_NET_BUYERS_REGIME' },
      cadence: 'daily',
    },
  },
  IND_NIFTY_08_VIX: {
    ruleType: 'band',
    ruleDefinition: {
      type: 'band_with_flag',
      bands: [
        { min: null, max: 12.0, score: 1 },
        { min: 12.0, max: 15.0, score: 0 },
        { min: 15.0, max: 20.0, score: -1 },
        { min: 20.0, max: null, score: -1, flag: 'CONTRARIAN_WATCH' },
      ],
      cadence: 'daily',
    },
  },
  IND_NIFTY_09_USD_WEAKNESS: {
    ruleType: 'custom',
    ruleDefinition: {
      type: 'manual_raw_composite',
      raw_range: { min: -14, max: 14 },
      tiers: [
        { min: null, max: -7, score: 2, read: 'deeply weak USD' },
        { min: -7, max: -4, score: 1, read: 'weak USD', exclusive_min: true },
        { min: -4, max: 3, score: 0, read: 'neutral', exclusive_min: true, exclusive_max: false },
        { min: 3, max: 6, score: -1, read: 'strong USD', exclusive_min: true },
        { min: 6, max: null, score: -2, read: 'deeply strong USD', exclusive_min: true },
      ],
      note: 'Raw composite is USD-strength sum of 14 indicators (range -14 to +14). Output is NIFTY-facing (flipped). Handler scores into 5 levels: +2/+1/0/-1/-2.',
      note_bridge:
        'Now bridged from EdgeFinder via ind9-bridge.service. Raw sum delivered via data_points.value; handler consumes unchanged.',
    },
  },
  IND_NIFTY_10_DXY: {
    ruleType: 'direction',
    ruleDefinition: {
      type: 'rolling_pct_direction',
      lookback_trading_days: 10,
      tiers: [
        { min: null, max: -0.5, score: 1 },
        { min: -0.5, max: 0.5, score: 0 },
        { min: 0.5, max: null, score: -1 },
      ],
      cadence: 'daily',
    },
  },
  IND_NIFTY_11_BRENT: {
    ruleType: 'direction',
    ruleDefinition: {
      type: 'rolling_pct_direction',
      lookback_trading_days: 10,
      tiers: [
        { min: null, max: -2.0, score: 1 },
        { min: -2.0, max: 2.0, score: 0 },
        { min: 2.0, max: null, score: -1 },
      ],
      cadence: 'daily',
    },
  },
  IND_NIFTY_12_USDINR: {
    ruleType: 'custom',
    ruleDefinition: {
      type: 'rolling_pct_tiered',
      lookback_trading_days: 10,
      tiers: [
        { min: null, max: -0.7, score: 2 },
        { min: -0.7, max: -0.3, score: 1 },
        { min: -0.3, max: 0.3, score: 0 },
        { min: 0.3, max: 0.7, score: -1 },
        { min: 0.7, max: null, score: -2 },
      ],
      cadence: 'daily',
    },
  },
  IND_NIFTY_13_FII_LS_RATIO: {
    ruleType: 'custom',
    ruleDefinition: {
      type: 'threshold_bands',
      metric: 'long_pct',
      bands: [
        { min: 55.0, max: null, score: 1 },
        { min: 45.0, max: 55.0, score: 0 },
        { min: null, max: 45.0, score: -1 },
      ],
      cadence: 'daily',
      live_tracking_only: true,
      historical_default: 0,
    },
  },
};

const SCORECARD_RATING_V2 = {
  ranges: [
    { min: 10, max: 17, label: 'Strong Bullish' },
    { min: 7, max: 9, label: 'Bullish' },
    { min: 4, max: 6, label: 'Neutral' },
    { min: 3, max: 3, label: 'Caution' },
    { min: 0, max: 2, label: 'Bearish' },
    { min: -17, max: -1, label: 'Strong Bearish' },
  ],
  conflict_flag: {
    fires_when: 'external_composite <= -3',
    pattern: 'P9-4',
  },
  source: 'Lucid NIFTY Tool Architecture v2.0 Section 4',
};

async function expireV1Rules(): Promise<void> {
  const updated = await prisma.scoringRule.updateMany({
    where: { effectiveTo: null, version: 1 },
    data: { effectiveTo: V1_END_DATE },
  });
  console.log(`Expired ${updated.count} v1 scoring rules`);

  const updatedRating = await prisma.scorecardRatingRule.updateMany({
    where: { effectiveTo: null, version: 1 },
    data: { effectiveTo: V1_END_DATE },
  });
  console.log(`Expired ${updatedRating.count} v1 scorecard rating rules`);
}

async function insertV2Rules(): Promise<void> {
  const indicators = await prisma.indicator.findMany({
    where: { tool: 'nifty' },
    select: { id: true, code: true },
  });

  let count = 0;
  for (const ind of indicators) {
    const v2 = SCORING_RULES_V2[ind.code];
    if (!v2) {
      console.warn(`No v2 rule defined for ${ind.code} — skipping`);
      continue;
    }

    await prisma.scoringRule.upsert({
      where: { indicatorId_version: { indicatorId: ind.id, version: 2 } },
      update: {},
      create: {
        indicatorId: ind.id,
        version: 2,
        ruleType: v2.ruleType,
        ruleDefinition: v2.ruleDefinition,
        effectiveFrom: V2_START_DATE,
        notes:
          'v2 — Lucid NIFTY Tool Architecture v2.0 (May 2026). Mechanical, direction-only at sub-indicator level.',
      },
    });
    count++;
  }
  console.log(`Inserted ${count} v2 scoring rules`);

  await prisma.scorecardRatingRule.upsert({
    where: { tool_version: { tool: 'nifty', version: 2 } },
    update: {},
    create: {
      tool: 'nifty',
      version: 2,
      rules: SCORECARD_RATING_V2,
      effectiveFrom: V2_START_DATE,
    },
  });
  console.log('Inserted v2 NIFTY scorecard rating rules');
}

async function main(): Promise<void> {
  console.log('🌱 Migrating to v2 scoring rules...');
  await expireV1Rules();
  await insertV2Rules();
  console.log('✅ v2 migration complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

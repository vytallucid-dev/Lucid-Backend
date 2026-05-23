import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    ALLOWED_ORIGINS: ['http://localhost:3000'],
  },
}));

// Auth covered separately; here we stub it so route logic can be tested in isolation.
vi.mock('@core/middleware/supabase-auth.middleware', () => ({
  requireAuth: (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = {
      sub: 'test-user-id',
      email: 'test@example.com',
      aud: 'authenticated',
      app_metadata: { role: 'user' },
    };
    next();
  },
  requireRole: () => (_req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => next(),
}));

vi.mock('@core/db/prisma', () => ({
  prisma: {
    asset: { findMany: vi.fn(), findFirst: vi.fn() },
    edgefinderScorecard: { findMany: vi.fn(), findFirst: vi.fn() },
    edgefinderPairScore: { findMany: vi.fn(), findFirst: vi.fn() },
    indicator: { findMany: vi.fn(), findUnique: vi.fn() },
    dataPoint: { findMany: vi.fn(), findFirst: vi.fn() },
    cotData: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

import express from 'express';
import request from 'supertest';
import { prisma } from '@core/db/prisma';
import { oracleRouter } from '@modules/edgefinder/api/oracle.routes';
import { requireAuth } from '@core/middleware/supabase-auth.middleware';
import { errorHandler } from '@core/middleware/error-handler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/oracle', requireAuth, oracleRouter);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

const mockedAsset = prisma.asset as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedScorecard = prisma.edgefinderScorecard as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedPairScore = prisma.edgefinderPairScore as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedIndicator = prisma.indicator as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedDataPoint = prisma.dataPoint as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedCotData = prisma.cotData as unknown as Record<string, ReturnType<typeof vi.fn>>;

const fxPairCodes = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'GBPJPY'];

function makeAssets() {
  return [
    ...fxPairCodes.map((code, i) => ({ id: `asset-${code}`, code })),
    { id: 'asset-XAUUSD', code: 'XAUUSD' },
    { id: 'asset-SPY', code: 'SPY' },
    { id: 'asset-NAS100', code: 'NAS100' },
  ];
}

function makePairScoreRow(pairCode: string) {
  return {
    pairId: `asset-${pairCode}`,
    totalScore: 3,
    pairCotScore: 1,
    rowBreakdown: [
      { rowName: 'GDP', uiGroup: 'Growth', indicatorA: { code: `EU_GDP_QOQ`, score: 1, outcome: 'scored', direction: null }, indicatorB: { code: `US_GDP_QOQ`, score: -1, outcome: 'scored', direction: null }, pairScore: 1, notes: null, rowIncluded: true },
    ],
  };
}

function makeXauScorecard() {
  return {
    totalScore: 4,
    cotScore: 1,
    indicatorBreakdown: [
      { indicatorCode: 'US_GDP_QOQ', score: 1, uiGroup: 'Growth', isCot: false, outcome: 'scored' },
      { indicatorCode: 'XAU_COT', score: 1, uiGroup: 'COT', isCot: true, outcome: 'scored' },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedScorecard.findMany.mockResolvedValue([]);
  mockedPairScore.findMany.mockResolvedValue([]);
});

// ============================================================================
// GET /api/oracle/assets
// ============================================================================

describe('GET /api/oracle/assets', () => {
  it('returns success:true and data array with 8 assets', async () => {
    mockedAsset.findMany.mockResolvedValue(makeAssets());
    mockedPairScore.findMany.mockResolvedValue(
      fxPairCodes.map(makePairScoreRow),
    );
    mockedScorecard.findFirst.mockResolvedValue(makeXauScorecard());

    const res = await request(app)
      .get('/api/oracle/assets')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(8);
  });

  it('returns outcome=deferred with null score/bias/cot and all 14 indicator slots null for SPY and NAS100', async () => {
    mockedAsset.findMany.mockResolvedValue(makeAssets());
    mockedPairScore.findMany.mockResolvedValue(
      fxPairCodes.map(makePairScoreRow),
    );
    mockedScorecard.findFirst.mockResolvedValue(makeXauScorecard());

    const res = await request(app)
      .get('/api/oracle/assets')
;

    for (const code of ['SPY', 'NAS100']) {
      const row = res.body.data.find((d: { asset: string }) => d.asset === code);
      expect(row, `${code} row should exist`).toBeDefined();
      expect(row.outcome).toBe('deferred');
      expect(row.score).toBeNull();
      expect(row.bias).toBeNull();
      expect(row.cot).toBeNull();
      expect(typeof row.reason).toBe('string');
      expect(row.reason.length).toBeGreaterThan(0);
      for (const slot of ['gdp', 'pmiM', 'pmiS', 'retail', 'consConf', 'cpi', 'ppi', 'pce', 'yield', 'nfp', 'unemp', 'claims', 'adp', 'jolts']) {
        expect(row[slot], `${code}.${slot} should be null`).toBeNull();
      }
    }
  });

  it('returns outcome=scored with populated score/bias/cot for active FX pair with data', async () => {
    mockedAsset.findMany.mockResolvedValue(makeAssets());
    mockedPairScore.findMany.mockResolvedValue(
      fxPairCodes.map(makePairScoreRow),
    );
    mockedScorecard.findFirst.mockResolvedValue(makeXauScorecard());

    const res = await request(app)
      .get('/api/oracle/assets')
;

    const eur = res.body.data.find((d: { asset: string }) => d.asset === 'EURUSD');
    expect(eur.outcome).toBe('scored');
    expect(eur.reason).toBeNull();
    expect(typeof eur.score).toBe('number');
    expect(eur.bias).not.toBeNull();
    expect(eur.cot).not.toBeNull();
  });

  it('returns null for US-specific slots (pce/nfp/adp/jolts/claims) on GBPJPY where both sides are absent', async () => {
    mockedAsset.findMany.mockResolvedValue(makeAssets());
    mockedPairScore.findMany.mockResolvedValue([
      {
        pairId: 'asset-GBPJPY',
        totalScore: 0,
        pairCotScore: 0,
        rowBreakdown: [
          // US-specific rows that the scoring engine keeps rowIncluded=true with pairScore=0
          // but both sides absent because neither GBP nor JPY has a PCE/NFP/etc indicator
          { rowName: 'PCE', uiGroup: 'Inflation', indicatorA: { code: null, score: 0, outcome: 'absent', direction: null }, indicatorB: { code: null, score: 0, outcome: 'absent', direction: null }, pairScore: 0, notes: 'PCE excluded from non-USD pair scoring per spec', rowIncluded: true },
          { rowName: 'NFP / Employment', uiGroup: 'Jobs', indicatorA: { code: null, score: 0, outcome: 'absent', direction: null }, indicatorB: { code: null, score: 0, outcome: 'absent', direction: null }, pairScore: 0, notes: 'NFP / Employment excluded from non-USD pair scoring per spec', rowIncluded: true },
          { rowName: 'ADP', uiGroup: 'Jobs', indicatorA: { code: null, score: 0, outcome: 'absent', direction: null }, indicatorB: { code: null, score: 0, outcome: 'absent', direction: null }, pairScore: 0, notes: 'ADP excluded from non-USD pair scoring per spec', rowIncluded: true },
          { rowName: 'JOLTS', uiGroup: 'Jobs', indicatorA: { code: null, score: 0, outcome: 'absent', direction: null }, indicatorB: { code: null, score: 0, outcome: 'absent', direction: null }, pairScore: 0, notes: 'JOLTS excluded from non-USD pair scoring per spec', rowIncluded: true },
          { rowName: 'Jobless Claims', uiGroup: 'Jobs', indicatorA: { code: null, score: 0, outcome: 'absent', direction: null }, indicatorB: { code: null, score: 0, outcome: 'absent', direction: null }, pairScore: 0, notes: 'Jobless Claims excluded from non-USD pair scoring per spec', rowIncluded: true },
          // A real bilateral row that actually scored
          { rowName: 'GDP', uiGroup: 'Growth', indicatorA: { code: 'UK_GDP_MOM', score: 1, outcome: 'scored', direction: null }, indicatorB: { code: 'JP_GDP_QOQ', score: -1, outcome: 'scored', direction: null }, pairScore: 2, notes: null, rowIncluded: true },
        ],
      },
    ]);
    mockedScorecard.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/oracle/assets')
;

    const gbpjpy = res.body.data.find((d: { asset: string }) => d.asset === 'GBPJPY');
    expect(gbpjpy.pce).toBeNull();
    expect(gbpjpy.nfp).toBeNull();
    expect(gbpjpy.adp).toBeNull();
    expect(gbpjpy.jolts).toBeNull();
    expect(gbpjpy.claims).toBeNull();
    // GDP slot scored normally
    expect(gbpjpy.gdp).toBe(1);
  });

  it('fills null indicator slots for FX pair with no rowBreakdown entry', async () => {
    mockedAsset.findMany.mockResolvedValue(makeAssets());
    mockedPairScore.findMany.mockResolvedValue(
      fxPairCodes.map((code) => ({
        pairId: `asset-${code}`,
        totalScore: 0,
        pairCotScore: 0,
        rowBreakdown: [],
      })),
    );
    mockedScorecard.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/oracle/assets')
;

    const eur = res.body.data.find((d: { asset: string }) => d.asset === 'EURUSD');
    expect(eur.gdp).toBeNull();
  });
});

// ============================================================================
// GET /api/oracle/scorecard
// ============================================================================

describe('GET /api/oracle/scorecard', () => {
  it('returns 400 for missing asset param', async () => {
    const res = await request(app)
      .get('/api/oracle/scorecard')
;
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid asset value', async () => {
    const res = await request(app)
      .get('/api/oracle/scorecard?asset=BOGUS')
;
    expect(res.status).toBe(400);
  });

  it('returns empty scorecard when asset not in DB', async () => {
    mockedAsset.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/oracle/scorecard?asset=USD')
;

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it('returns scorecard structure when data exists', async () => {
    mockedAsset.findFirst.mockResolvedValue({ id: 'asset-USD', code: 'USD' });
    mockedScorecard.findFirst.mockResolvedValue({
      totalScore: 3,
      fundamentalsScore: 2,
      cotScore: 1,
      observationDate: new Date('2026-05-16'),
      indicatorBreakdown: [
        { indicatorCode: 'US_CPI_YOY', score: 1, uiGroup: 'Inflation', isCot: false, outcome: 'scored', reason: null },
      ],
    });
    mockedIndicator.findMany.mockResolvedValue([{ id: 'ind-cpi', code: 'US_CPI_YOY', name: 'CPI YoY' }]);
    mockedDataPoint.findMany.mockResolvedValue([{
      indicatorId: 'ind-cpi',
      observationDate: new Date('2026-05-10'),
      value: '3.5',
      forecastValue: '3.4',
      previousValue: '3.2',
    }]);
    mockedCotData.findFirst.mockResolvedValue(null);
    mockedScorecard.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/scorecard?asset=USD')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.key).toBe('USD');
    expect(res.body.data.totalScore).toBe(3);
    expect(Array.isArray(res.body.data.sections)).toBe(true);
    expect(Array.isArray(res.body.data.scoreHistory)).toBe(true);
    expect(res.body.data.scoreHistory).toHaveLength(12);

    const inflSection = res.body.data.sections.find((s: { label: string }) => s.label === 'INFLATION');
    expect(inflSection.indicators[0].outcome).toBe('scored');
    expect(inflSection.indicators[0].score).toBe(1);
    expect(inflSection.indicators[0].actual).toBe('3.5%');
  });

  it('returns outcome=deferred with null fields for SPY', async () => {
    // No DB mocks needed — deferred path short-circuits before any query
    const res = await request(app)
      .get('/api/oracle/scorecard?asset=SPY')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.key).toBe('SPY');
    expect(res.body.data.outcome).toBe('deferred');
    expect(res.body.data.totalScore).toBeNull();
    expect(res.body.data.fundamentals).toBeNull();
    expect(res.body.data.cotScore).toBeNull();
    expect(res.body.data.bias).toBeNull();
    expect(res.body.data.cot).toBeNull();
    expect(res.body.data.scoreHistory).toBeNull();
    expect(res.body.data.sections).toHaveLength(0);
    expect(typeof res.body.data.reason).toBe('string');
    expect(res.body.data.reason.length).toBeGreaterThan(0);
  });

  it('returns outcome=deferred with null fields for NAS100', async () => {
    const res = await request(app)
      .get('/api/oracle/scorecard?asset=NAS100')
;

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('deferred');
    expect(res.body.data.totalScore).toBeNull();
    expect(res.body.data.cot).toBeNull();
    expect(res.body.data.scoreHistory).toBeNull();
    expect(res.body.data.sections).toHaveLength(0);
    expect(res.body.data.reason).toBe('Scoring deferred pending backtesting. Activation planned post-v1.');
  });

  it('returns outcome=insufficient_data with null fields when asset is in DB but has no scorecard', async () => {
    mockedAsset.findFirst.mockResolvedValue({ id: 'asset-USD', code: 'USD' });
    mockedScorecard.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/oracle/scorecard?asset=USD')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.outcome).toBe('insufficient_data');
    expect(res.body.data.totalScore).toBeNull();
    expect(res.body.data.fundamentals).toBeNull();
    expect(res.body.data.cotScore).toBeNull();
    expect(res.body.data.bias).toBeNull();
    expect(res.body.data.cot).toBeNull();
    expect(res.body.data.scoreHistory).toBeNull();
    expect(res.body.data.sections).toHaveLength(0);
    expect(typeof res.body.data.reason).toBe('string');
  });

  it('returns outcome=scored with reason=null when scorecard exists', async () => {
    mockedAsset.findFirst.mockResolvedValue({ id: 'asset-USD', code: 'USD' });
    mockedScorecard.findFirst.mockResolvedValue({
      totalScore: 3,
      fundamentalsScore: 2,
      cotScore: 1,
      observationDate: new Date('2026-05-16'),
      indicatorBreakdown: [
        { indicatorCode: 'US_CPI_YOY', score: 1, uiGroup: 'Inflation', isCot: false, outcome: 'scored', reason: null },
      ],
    });
    mockedIndicator.findMany.mockResolvedValue([{ id: 'ind-cpi', code: 'US_CPI_YOY', name: 'CPI YoY' }]);
    mockedDataPoint.findMany.mockResolvedValue([{
      indicatorId: 'ind-cpi',
      observationDate: new Date('2026-05-10'),
      value: '3.5',
      forecastValue: '3.4',
      previousValue: '3.2',
    }]);
    mockedCotData.findFirst.mockResolvedValue(null);
    mockedScorecard.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/scorecard?asset=USD')
;

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('scored');
    expect(res.body.data.reason).toBeNull();
    expect(res.body.data.totalScore).toBe(3);
    expect(res.body.data.bias).not.toBeNull();
  });

  it('returns null score and null actual for scorecard indicator with outcome=insufficient_data', async () => {
    mockedAsset.findFirst.mockResolvedValue({ id: 'asset-USD', code: 'USD' });
    mockedScorecard.findFirst.mockResolvedValue({
      totalScore: 0,
      fundamentalsScore: 0,
      cotScore: 0,
      observationDate: new Date('2026-05-16'),
      indicatorBreakdown: [
        { indicatorCode: 'US_ADP', score: null, uiGroup: 'Jobs', isCot: false, outcome: 'insufficient_data', reason: 'No data point found on or before observation date' },
      ],
    });
    mockedIndicator.findMany.mockResolvedValue([{ id: 'ind-adp', code: 'US_ADP', name: 'ADP Employment Change' }]);
    mockedDataPoint.findMany.mockResolvedValue([]);
    mockedCotData.findFirst.mockResolvedValue(null);
    mockedScorecard.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/scorecard?asset=USD')
;

    expect(res.status).toBe(200);
    const jobsSection = res.body.data.sections.find((s: { label: string }) => s.label === 'JOBS MARKET');
    const adp = jobsSection.indicators[0];
    expect(adp.score).toBeNull();
    expect(adp.actual).toBeNull();
    expect(adp.forecast).toBeNull();
    expect(adp.previous).toBeNull();
    expect(adp.outcome).toBe('insufficient_data');
    expect(adp.reason).toBe('No data point found on or before observation date');
    expect(jobsSection.subtotal).toBe(0);
  });
});

// ============================================================================
// GET /api/oracle/cot
// ============================================================================

describe('GET /api/oracle/cot', () => {
  it('returns success:true with 8-element data array when no COT data', async () => {
    mockedAsset.findMany.mockResolvedValue(makeAssets());
    mockedCotData.findMany.mockResolvedValue([]);
    mockedPairScore.findMany.mockResolvedValue([]);
    mockedScorecard.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/cot')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(8);
  });

  it('returns null numeric fields and outcome=insufficient_data when no COT data ingested', async () => {
    mockedAsset.findMany.mockResolvedValue(makeAssets());
    mockedCotData.findMany.mockResolvedValue([]);
    mockedPairScore.findMany.mockResolvedValue([]);
    mockedScorecard.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/cot')
;

    const eur = res.body.data.find((d: { asset: string }) => d.asset === 'EURUSD');
    expect(eur.outcome).toBe('insufficient_data');
    expect(eur.reason).toBeTruthy();
    expect(eur.longContracts).toBeNull();
    expect(eur.shortContracts).toBeNull();
    expect(eur.deltaLong).toBeNull();
    expect(eur.deltaShort).toBeNull();
    expect(eur.longPct).toBeNull();
    expect(eur.shortPct).toBeNull();
    expect(eur.netPctChange).toBeNull();
    expect(eur.netPosition).toBeNull();
    expect(eur.cotScore).toBeNull();
    expect(eur.trend).toBeNull();
  });

  it('returns populated fields and outcome=scored when COT data exists', async () => {
    mockedAsset.findMany.mockResolvedValue(makeAssets());
    mockedCotData.findMany.mockResolvedValue([
      {
        assetId: 'asset-EURUSD',
        longContracts: 100000,
        shortContracts: 80000,
        changeInLongContracts: 5000,
        changeInShortContracts: -3000,
        longPct: '55.5',
        shortPct: '44.5',
        weeklyChangePct: '2.1',
        netPositioningLabel: 'Bullish',
        changeLabel: 'Bullish',
      },
    ]);
    mockedPairScore.findMany.mockResolvedValue([{ pairId: 'asset-EURUSD', pairCotScore: 1 }]);
    mockedScorecard.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/cot')
;

    const eur = res.body.data.find((d: { asset: string }) => d.asset === 'EURUSD');
    expect(eur.outcome).toBe('scored');
    expect(eur.reason).toBeNull();
    expect(eur.longContracts).toBe(100000);
    expect(eur.shortContracts).toBe(80000);
    expect(eur.netPosition).toBe(20000);
    expect(eur.cotScore).toBe(1);
    expect(Array.isArray(eur.trend)).toBe(true);
  });

  it('populates cotScore from pairScore for FX pairs', async () => {
    mockedAsset.findMany.mockResolvedValue(makeAssets());
    mockedCotData.findMany.mockResolvedValue([
      {
        assetId: 'asset-EURUSD',
        longContracts: 100000,
        shortContracts: 80000,
        changeInLongContracts: 5000,
        changeInShortContracts: -3000,
        longPct: '55.5',
        shortPct: '44.5',
        weeklyChangePct: '2.1',
        netPositioningLabel: 'Bullish',
        changeLabel: 'Bullish',
      },
    ]);
    mockedPairScore.findMany.mockResolvedValue([{ pairId: 'asset-EURUSD', pairCotScore: 2 }]);
    mockedScorecard.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/cot')
;

    const eur = res.body.data.find((d: { asset: string }) => d.asset === 'EURUSD');
    expect(eur.cotScore).toBe(2);
    expect(eur.longContracts).toBe(100000);
  });
});

// ============================================================================
// GET /api/oracle/heatmap
// ============================================================================

describe('GET /api/oracle/heatmap', () => {
  it('returns grouped response with US/EU/UK/JP keys', async () => {
    mockedIndicator.findMany.mockResolvedValue([
      { id: 'ind-cpi', code: 'US_CPI_YOY', name: 'CPI YoY', country: 'US', uiGroup: 'Inflation', frequency: 'monthly', isActive: true },
    ]);
    mockedAsset.findMany.mockResolvedValue([{ id: 'asset-USD', code: 'USD' }]);
    mockedDataPoint.findMany.mockResolvedValue([]);
    mockedScorecard.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/heatmap')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('US');
    expect(res.body.data).toHaveProperty('EU');
    expect(res.body.data).toHaveProperty('UK');
    expect(res.body.data).toHaveProperty('JP');
  });

  it('includes a US indicator in US array when data is present', async () => {
    mockedIndicator.findMany.mockResolvedValue([
      { id: 'ind-cpi', code: 'US_CPI_YOY', name: 'US CPI YoY', country: 'US', uiGroup: 'Inflation', frequency: 'monthly', isActive: true },
    ]);
    mockedAsset.findMany.mockResolvedValue([{ id: 'asset-USD', code: 'USD' }]);
    mockedDataPoint.findMany.mockResolvedValue([{
      indicatorId: 'ind-cpi',
      observationDate: new Date('2026-05-10'),
      value: '3.5',
      forecastValue: '3.4',
      previousValue: '3.2',
    }]);
    mockedScorecard.findMany.mockResolvedValue([{
      assetId: 'asset-USD',
      indicatorBreakdown: [
        { indicatorCode: 'US_CPI_YOY', score: 1, uiGroup: 'Inflation', isCot: false, outcome: 'scored', reason: null },
      ],
    }]);

    const res = await request(app)
      .get('/api/oracle/heatmap')
;

    expect(res.body.data.US).toHaveLength(1);
    expect(res.body.data.US[0].name).toBe('US CPI YoY');
    expect(res.body.data.US[0].score).toBe(1);
    expect(res.body.data.US[0].outcome).toBe('scored');
    expect(res.body.data.US[0].reason).toBeNull();
    expect(res.body.data.US[0].actual).toBe('3.5%');
  });

  it('returns null score, null actual, and outcome=insufficient_data when indicator has no data', async () => {
    mockedIndicator.findMany.mockResolvedValue([
      { id: 'ind-adp', code: 'US_ADP', name: 'ADP Employment Change', country: 'US', uiGroup: 'Jobs', frequency: 'monthly', isActive: true },
    ]);
    mockedAsset.findMany.mockResolvedValue([{ id: 'asset-USD', code: 'USD' }]);
    mockedDataPoint.findMany.mockResolvedValue([]);
    mockedScorecard.findMany.mockResolvedValue([{
      assetId: 'asset-USD',
      indicatorBreakdown: [
        { indicatorCode: 'US_ADP', score: null, uiGroup: 'Jobs', isCot: false, outcome: 'insufficient_data', reason: 'No data point found on or before observation date' },
      ],
    }]);

    const res = await request(app)
      .get('/api/oracle/heatmap')
;

    const row = res.body.data.US[0];
    expect(row.score).toBeNull();
    expect(row.actual).toBeNull();
    expect(row.forecast).toBeNull();
    expect(row.previous).toBeNull();
    expect(row.surprise).toBeNull();
    expect(row.outcome).toBe('insufficient_data');
    expect(row.reason).toBe('No data point found on or before observation date');
  });

  it('does not return score:1 for indicator with outcome=insufficient_data even if a stale data_point with value=0 exists', async () => {
    mockedIndicator.findMany.mockResolvedValue([
      { id: 'ind-nfp', code: 'US_NFP', name: 'Non-Farm Payrolls', country: 'US', uiGroup: 'Jobs', frequency: 'monthly', isActive: true },
    ]);
    mockedAsset.findMany.mockResolvedValue([{ id: 'asset-USD', code: 'USD' }]);
    mockedDataPoint.findMany.mockResolvedValue([{
      indicatorId: 'ind-nfp',
      observationDate: new Date('2025-01-01'), // very old
      value: '0',
      forecastValue: null,
      previousValue: null,
    }]);
    mockedScorecard.findMany.mockResolvedValue([{
      assetId: 'asset-USD',
      indicatorBreakdown: [
        { indicatorCode: 'US_NFP', score: null, uiGroup: 'Jobs', isCot: false, outcome: 'insufficient_data', reason: 'No forecast and no previous reading available' },
      ],
    }]);

    const res = await request(app)
      .get('/api/oracle/heatmap')
;

    const row = res.body.data.US[0];
    expect(row.score).toBeNull();
    expect(row.actual).toBeNull();
    expect(row.outcome).toBe('insufficient_data');
  });

  it('returns outcome=stale when indicator has data older than 60 days', async () => {
    mockedIndicator.findMany.mockResolvedValue([
      { id: 'ind-cpi', code: 'US_CPI_YOY', name: 'CPI YoY', country: 'US', uiGroup: 'Inflation', frequency: 'monthly', isActive: true },
    ]);
    mockedAsset.findMany.mockResolvedValue([{ id: 'asset-USD', code: 'USD' }]);
    mockedDataPoint.findMany.mockResolvedValue([{
      indicatorId: 'ind-cpi',
      observationDate: new Date('2025-01-01'), // >60 days ago
      value: '3.1',
      forecastValue: '3.0',
      previousValue: '2.9',
    }]);
    mockedScorecard.findMany.mockResolvedValue([{
      assetId: 'asset-USD',
      indicatorBreakdown: [
        { indicatorCode: 'US_CPI_YOY', score: 1, uiGroup: 'Inflation', isCot: false, outcome: 'scored', reason: null },
      ],
    }]);

    const res = await request(app)
      .get('/api/oracle/heatmap')
;

    const row = res.body.data.US[0];
    expect(row.outcome).toBe('stale');
    expect(row.stale).toBe(true);
    expect(row.score).toBe(1); // score is still populated for stale
    expect(row.actual).toBe('3.1%');
  });
});

// ============================================================================
// GET /api/oracle/fx-scorecard
// ============================================================================

describe('GET /api/oracle/fx-scorecard', () => {
  it('returns 400 for invalid pair param', async () => {
    const res = await request(app)
      .get('/api/oracle/fx-scorecard?pair=INVALID')
;
    expect(res.status).toBe(400);
  });

  it('returns all 5 pairs when no pair filter', async () => {
    mockedAsset.findMany.mockResolvedValue(
      fxPairCodes.map((code) => ({ id: `asset-${code}`, code })),
    );
    mockedPairScore.findFirst.mockResolvedValue(null);
    mockedScorecard.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/fx-scorecard')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns single FxPairData object when pair filter used', async () => {
    mockedAsset.findMany.mockResolvedValue([{ id: 'asset-EURUSD', code: 'EURUSD' }]);
    mockedPairScore.findFirst.mockResolvedValue({
      totalScore: 3,
      basePairScore: 2,
      pairCotScore: 1,
      rowBreakdown: [],
      cotBreakdown: null,
      scoreDate: new Date('2026-05-16'),
    });
    mockedPairScore.findMany.mockResolvedValue([]);
    mockedAsset.findFirst.mockResolvedValue(null);
    mockedCotData.findFirst.mockResolvedValue(null);
    mockedIndicator.findMany.mockResolvedValue([]);
    mockedDataPoint.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/fx-scorecard?pair=EURUSD')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.key).toBe('EURUSD');
    expect(res.body.data.label).toBe('EUR / USD');
    expect(Array.isArray(res.body.data.scoreHistory)).toBe(true);
    expect(res.body.data.scoreHistory).toHaveLength(12);
  });

  it('returns 404 when requested pair asset not in DB', async () => {
    mockedAsset.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/oracle/fx-scorecard?pair=EURUSD')
;

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAIR_NOT_FOUND');
  });

  it('returns outcome=insufficient_data with null numeric fields when no pair score row exists', async () => {
    mockedAsset.findMany.mockResolvedValue([{ id: 'asset-EURUSD', code: 'EURUSD' }]);
    mockedPairScore.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/oracle/fx-scorecard?pair=EURUSD')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.outcome).toBe('insufficient_data');
    expect(res.body.data.totalScore).toBeNull();
    expect(res.body.data.fundamentals).toBeNull();
    expect(res.body.data.cotScore).toBeNull();
    expect(res.body.data.bias).toBeNull();
    expect(res.body.data.cotA).toBeNull();
    expect(res.body.data.cotB).toBeNull();
    expect(res.body.data.scoreHistory).toBeNull();
    expect(Array.isArray(res.body.data.categories)).toBe(true);
    expect(res.body.data.categories).toHaveLength(0);
    expect(typeof res.body.data.reason).toBe('string');
    expect(res.body.data.reason.length).toBeGreaterThan(0);
  });
});

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

// Auth middleware stubbed: every request becomes an authenticated 'user'.
// Auth itself is covered in tests/core/middleware/supabase-auth.middleware.test.ts.
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

vi.mock('@modules/nifty/services/public-api.service', () => ({
  getLatestScorecard: vi.fn(),
  getScorecardHistory: vi.fn(),
}));

import express from 'express';
import request from 'supertest';
import { getLatestScorecard, getScorecardHistory } from '@modules/nifty/services/public-api.service';
import { niftyPublicV2Router } from '@modules/nifty/api/nifty.routes';
import { requireAuth } from '@core/middleware/supabase-auth.middleware';
import { errorHandler } from '@core/middleware/error-handler';

const mockedGetLatest = getLatestScorecard as unknown as ReturnType<typeof vi.fn>;
const mockedGetHistory = getScorecardHistory as unknown as ReturnType<typeof vi.fn>;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/nifty', requireAuth, niftyPublicV2Router);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

function makePublicScorecard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    date: '2026-05-16',
    phase: 'Phase 2',
    bucket: 'BULL',
    indicators: [
      {
        id: 101,
        name: 'US CPI YoY',
        short: 'CPI',
        composite: 'domestic',
        score: 1,
        value: '3.5%',
        magnitude: 'Moderate',
        last_change_date: '2026-03-01',
        // These should be stripped by the v2 router:
        code: 'US_CPI_YOY',
        outcome: 'scored',
        flags: [],
        reason: 'Beat forecast',
      },
    ],
    domestic_composite: 4,
    external_composite: -1,
    net_score: 3,
    band: 'Bullish',
    ind9_raw_composite: null,
    ind9_sub_indicators: {},
    composition_flag: null,
    peak_score_active: false,
    conflict_flag: false,
    notes: null,
    catalysts: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// GET /api/nifty/scorecards/latest
// ============================================================================

describe('GET /api/nifty/scorecards/latest', () => {
  it('returns 404 when no scorecard exists', async () => {
    mockedGetLatest.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/nifty/scorecards/latest');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SCORECARD_NOT_FOUND');
  });

  it('returns NiftyScorecard shape without code/outcome/flags/reason on indicators', async () => {
    mockedGetLatest.mockResolvedValue(makePublicScorecard());

    const res = await request(app)
      .get('/api/nifty/scorecards/latest')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.id).toBe(1);
    expect(data.net_score).toBe(3);
    expect(data.band).toBe('Bullish');

    // Indicator fields must not include sensitive fields
    const ind = data.indicators[0];
    expect(ind.id).toBe(101);
    expect(ind.name).toBe('US CPI YoY');
    expect(ind.score).toBe(1);
    expect(ind).not.toHaveProperty('code');
    expect(ind).not.toHaveProperty('outcome');
    expect(ind).not.toHaveProperty('flags');
    expect(ind).not.toHaveProperty('reason');
  });

  it('converts score values to NiftyIndicatorScore range', async () => {
    mockedGetLatest.mockResolvedValue(
      makePublicScorecard({
        indicators: [{
          id: 102,
          name: 'Test',
          short: 'T',
          composite: 'domestic',
          score: 999,  // out of range — should clamp to 0
          value: '—',
          magnitude: '—',
          last_change_date: '2026-01-01',
          code: 'TEST',
          outcome: 'scored',
        }],
      }),
    );

    const res = await request(app)
      .get('/api/nifty/scorecards/latest')
;

    expect(res.body.data.indicators[0].score).toBe(0);
  });
});

// ============================================================================
// GET /api/nifty/scorecards
// ============================================================================

describe('GET /api/nifty/scorecards', () => {
  it('returns 400 for invalid limit', async () => {
    const res = await request(app)
      .get('/api/nifty/scorecards?limit=abc')
;
    expect(res.status).toBe(400);
  });

  it('returns NiftyScorecardHistoryItem list', async () => {
    const historyItem = {
      id: 1,
      date: '2026-05-16',
      net_score: 3,
      domestic_composite: 4,
      external_composite: -1,
      band: 'Bullish',
      conflict_flag: false,
      composition_flag: null,
      peak_score_active: false,
      ind9_raw_composite: null,
    };
    mockedGetHistory.mockResolvedValue({ items: [historyItem], count: 1, limit: 25 });

    const res = await request(app)
      .get('/api/nifty/scorecards?limit=25')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.total).toBe(1);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].id).toBe(1);
    expect(res.body.data[0].band).toBe('Bullish');
  });

  it('caps limit at 365', async () => {
    mockedGetHistory.mockResolvedValue({ items: [], count: 0, limit: 365 });

    await request(app)
      .get('/api/nifty/scorecards?limit=9999')
;

    expect(mockedGetHistory).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 365 }),
    );
  });
});

// ============================================================================
// GET /api/nifty/patterns
// ============================================================================

describe('GET /api/nifty/patterns', () => {
  it('returns patterns array with count', async () => {
    const res = await request(app)
      .get('/api/nifty/patterns')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.count).toBe('number');
    expect(res.body.count).toBeGreaterThan(0);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('each pattern has required shape fields', async () => {
    const res = await request(app)
      .get('/api/nifty/patterns')
;

    const pattern = res.body.data[0];
    expect(pattern).toHaveProperty('id');
    expect(pattern).toHaveProperty('name');
    expect(pattern).toHaveProperty('tier');
    expect(pattern).toHaveProperty('category');
    expect(pattern).toHaveProperty('instances');
    expect(pattern).toHaveProperty('rule');
  });
});

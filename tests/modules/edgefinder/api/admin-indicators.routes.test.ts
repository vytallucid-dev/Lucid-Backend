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

// Auth covered separately; here we stub it so admin route logic can be tested.
vi.mock('@core/middleware/supabase-auth.middleware', () => ({
  requireAuth: (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = {
      sub: 'test-admin-id',
      email: 'admin@example.com',
      aud: 'authenticated',
      app_metadata: { role: 'admin' },
    };
    next();
  },
  requireRole: () => (_req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => next(),
}));

vi.mock('@core/db/prisma', () => ({
  prisma: {
    indicator: { findMany: vi.fn(), findUnique: vi.fn() },
    dataPoint: { findMany: vi.fn() },
  },
}));

import express from 'express';
import request from 'supertest';
import { prisma } from '@core/db/prisma';
import { adminIndicatorsRouter } from '@modules/edgefinder/api/admin-indicators.routes';
import { requireAuth, requireRole } from '@core/middleware/supabase-auth.middleware';
import { errorHandler } from '@core/middleware/error-handler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/indicators', requireAuth, requireRole('admin'), adminIndicatorsRouter);
  app.use(errorHandler);
  return app;
}

const app = makeApp();
const mockedIndicator = prisma.indicator as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedDataPoint = prisma.dataPoint as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
});

function makeIndicatorRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ind-1',
    code: 'US_CPI_YOY',
    name: 'US CPI YoY',
    country: 'US',
    uiGroup: 'Inflation',
    frequency: 'monthly',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    isActive: true,
    description: null,
    category: 'macro',
    tool: 'edgefinder',
    unit: '%',
    compositeGroup: null,
    displayOrder: 1,
    dataPoints: [],
    scoringRules: [],
    ...overrides,
  };
}

// ============================================================================
// GET /api/admin/indicators/list
// ============================================================================

describe('GET /api/admin/indicators/list', () => {
  it('returns list of indicators with count', async () => {
    mockedIndicator.findMany.mockResolvedValue([
      makeIndicatorRecord({
        dataPoints: [{
          observationDate: new Date('2026-05-10'),
          value: '3.5',
          source: 'manual',
          createdAt: new Date('2026-05-11T00:00:00.000Z'),
        }],
      }),
    ]);

    const res = await request(app)
      .get('/api/admin/indicators/list')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].code).toBe('US_CPI_YOY');
    expect(res.body.data[0].latestDataPoint).not.toBeNull();
    expect(res.body.data[0].latestDataPoint.value).toBe(3.5);
  });

  it('sets latestDataPoint to null when no data points', async () => {
    mockedIndicator.findMany.mockResolvedValue([makeIndicatorRecord()]);

    const res = await request(app)
      .get('/api/admin/indicators/list')
;

    expect(res.body.data[0].latestDataPoint).toBeNull();
  });

  it('filters by country query param', async () => {
    mockedIndicator.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/admin/indicators/list?country=US')
;

    expect(res.status).toBe(200);
    expect(mockedIndicator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ country: 'US' }),
      }),
    );
  });

  it('filters by isActive=true', async () => {
    mockedIndicator.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/admin/indicators/list?isActive=true')
;

    expect(mockedIndicator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });
});

// ============================================================================
// GET /api/admin/indicators/:code/latest
// ============================================================================

describe('GET /api/admin/indicators/:code/latest', () => {
  it('returns 404 when indicator not found', async () => {
    mockedIndicator.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/admin/indicators/BOGUS_CODE/latest')
;

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INDICATOR_NOT_FOUND');
  });

  it('returns data points for existing indicator', async () => {
    mockedIndicator.findUnique.mockResolvedValue({
      id: 'ind-1',
      code: 'US_CPI_YOY',
      name: 'US CPI YoY',
      unit: '%',
      frequency: 'monthly',
    });
    mockedDataPoint.findMany.mockResolvedValue([
      {
        id: 'dp-1',
        observationDate: new Date('2026-05-10'),
        value: '3.5',
        forecastValue: '3.4',
        previousValue: '3.2',
        isCurrent: true,
        source: 'manual',
        dataQualityFlag: null,
        sourceMetadata: {},
        notes: null,
        createdAt: new Date('2026-05-11T00:00:00.000Z'),
      },
    ]);

    const res = await request(app)
      .get('/api/admin/indicators/US_CPI_YOY/latest')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.indicator.code).toBe('US_CPI_YOY');
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].value).toBe(3.5);
    expect(res.body.data[0].forecastValue).toBe(3.4);
  });

  it('respects limit query param (default 10, max 100)', async () => {
    mockedIndicator.findUnique.mockResolvedValue({
      id: 'ind-1', code: 'US_CPI_YOY', name: 'US CPI YoY', unit: '%', frequency: 'monthly',
    });
    mockedDataPoint.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/admin/indicators/US_CPI_YOY/latest?limit=200')
;

    expect(mockedDataPoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });
});

// ============================================================================
// GET /api/admin/indicators/:code/field-spec
// ============================================================================

describe('GET /api/admin/indicators/:code/field-spec', () => {
  it('returns 404 for unknown indicator', async () => {
    mockedIndicator.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/admin/indicators/BOGUS/field-spec')
;

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INDICATOR_NOT_FOUND');
  });

  it('returns full indicator spec with scoring rules', async () => {
    mockedIndicator.findUnique.mockResolvedValue({
      ...makeIndicatorRecord(),
      scoringRules: [
        {
          id: 'rule-1',
          version: 1,
          ruleType: 'normal',
          ruleDefinition: {},
          effectiveFrom: new Date('2024-01-01'),
          effectiveTo: null,
          notes: null,
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
        },
      ],
    });

    const res = await request(app)
      .get('/api/admin/indicators/US_CPI_YOY/field-spec')
;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.code).toBe('US_CPI_YOY');
    expect(res.body.data.scoringRules).toHaveLength(1);
    expect(res.body.data.scoringRules[0].ruleType).toBe('normal');
    expect(res.body.data.scoringRules[0].effectiveFrom).toBe('2024-01-01');
    expect(res.body.data.scoringRules[0].effectiveTo).toBeNull();
  });
});

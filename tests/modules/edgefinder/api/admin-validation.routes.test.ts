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
    compassInput: {
      count: vi.fn(),
      findFirst: vi.fn(),
    },
    compassValidationReport: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: {
    start: vi.fn(),
    complete: vi.fn(),
  },
}));

vi.mock(
  '@modules/edgefinder/services/compass/validation/historical-backfill.service',
  () => ({
    backfillWindow: vi.fn(),
  }),
);

vi.mock(
  '@modules/edgefinder/services/compass/validation/validation-harness.service',
  () => ({
    runValidation: vi.fn(),
    getMostRecentReport: vi.fn(),
  }),
);

import express from 'express';
import request from 'supertest';
import { prisma } from '@core/db/prisma';
import { requireAuth, requireRole } from '@core/middleware/supabase-auth.middleware';
import { errorHandler } from '@core/middleware/error-handler';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { adminValidationRouter } from '@modules/edgefinder/api/admin-validation.routes';
import { backfillWindow } from '@modules/edgefinder/services/compass/validation/historical-backfill.service';
import {
  runValidation,
  getMostRecentReport,
} from '@modules/edgefinder/services/compass/validation/validation-harness.service';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/admin/compass/validation',
    requireAuth,
    requireRole('admin'),
    adminValidationRouter,
  );
  app.use(errorHandler);
  return app;
}

const app = makeApp();
const mockedCompassInput = prisma.compassInput as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const mockedReport = prisma.compassValidationReport as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const mockedStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;
const mockedBackfill = backfillWindow as unknown as ReturnType<typeof vi.fn>;
const mockedRun = runValidation as unknown as ReturnType<typeof vi.fn>;
const mockedGetReport = getMostRecentReport as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedStart.mockResolvedValue({ id: 'job-1' });
  mockedComplete.mockResolvedValue(undefined);
  mockedBackfill.mockResolvedValue({
    windowName: 'X',
    logId: 'l',
    totalTradingDays: 0,
    inputsBackfilled: 0,
    classificationsRun: 0,
    errors: [],
    durationMs: 0,
  });
});

// ============================================================================
// POST /backfill
// ============================================================================

describe('POST /api/admin/compass/validation/backfill', () => {
  it('rejects an unknown windowName', async () => {
    const res = await request(app)
      .post('/api/admin/compass/validation/backfill')
      .send({ windowName: 'BOGUS' });
    expect(res.status).toBe(400);
  });

  it('defaults to all 4 windows when body is empty', async () => {
    const res = await request(app)
      .post('/api/admin/compass/validation/backfill')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('started');
    expect(res.body.windowsQueued).toHaveLength(4);
  });

  it('queues a single window when windowName specified', async () => {
    const res = await request(app)
      .post('/api/admin/compass/validation/backfill')
      .send({ windowName: '2008_GFC' });
    expect(res.status).toBe(200);
    expect(res.body.windowsQueued).toEqual(['2008_GFC']);
  });

  it('returns a jobId tied to a fetch_log row', async () => {
    const res = await request(app)
      .post('/api/admin/compass/validation/backfill')
      .send({ windowName: 'all' });
    expect(res.body.jobId).toBe('job-1');
    expect(mockedStart).toHaveBeenCalledTimes(1);
  });

  it('responds immediately (does not wait for backfill to complete)', async () => {
    let resolved = false;
    mockedBackfill.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve({
              windowName: 'X',
              logId: 'l',
              totalTradingDays: 0,
              inputsBackfilled: 0,
              classificationsRun: 0,
              errors: [],
              durationMs: 0,
            });
          }, 100);
        }),
    );
    const res = await request(app)
      .post('/api/admin/compass/validation/backfill')
      .send({ windowName: '2008_GFC' });
    expect(res.status).toBe(200);
    expect(resolved).toBe(false);
  });
});

// ============================================================================
// GET /status
// ============================================================================

describe('GET /api/admin/compass/validation/status', () => {
  it('reports not_started when no rows exist', async () => {
    mockedCompassInput.count.mockResolvedValue(0);
    mockedCompassInput.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/admin/compass/validation/status')
;

    expect(res.status).toBe(200);
    expect(res.body.windows).toHaveLength(4);
    for (const w of res.body.windows) {
      expect(w.backfillStatus).toBe('not_started');
      expect(w.tradingDaysComplete).toBe(0);
      expect(w.tradingDaysExpected).toBeGreaterThan(0);
    }
  });

  it('reports completed when count >= expected rows (6 per trading day)', async () => {
    // Big number — overwhelms expected for any window
    mockedCompassInput.count.mockResolvedValue(100000);
    mockedCompassInput.findFirst.mockResolvedValue({ computedAt: new Date('2026-01-01') });

    const res = await request(app)
      .get('/api/admin/compass/validation/status')
;

    expect(res.status).toBe(200);
    for (const w of res.body.windows) {
      expect(w.backfillStatus).toBe('completed');
    }
  });

  it('reports in_progress when some inputs exist but not all', async () => {
    mockedCompassInput.count.mockResolvedValue(6); // exactly 1 day of inputs
    mockedCompassInput.findFirst.mockResolvedValue({ computedAt: new Date('2026-01-01') });

    const res = await request(app)
      .get('/api/admin/compass/validation/status')
;

    for (const w of res.body.windows) {
      expect(w.backfillStatus).toBe('in_progress');
      expect(w.tradingDaysComplete).toBe(1);
    }
  });
});

// ============================================================================
// POST /run
// ============================================================================

describe('POST /api/admin/compass/validation/run', () => {
  it('returns the report synchronously', async () => {
    mockedRun.mockResolvedValue({
      id: 'r-1',
      generatedAt: new Date(),
      windowResults: [],
      overallPassed: true,
      overallSummary: 'All passed.',
    });
    const res = await request(app)
      .post('/api/admin/compass/validation/run')
;
    expect(res.status).toBe(200);
    expect(res.body.overallPassed).toBe(true);
    expect(res.body.overallSummary).toBe('All passed.');
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// GET /report
// ============================================================================

describe('GET /api/admin/compass/validation/report', () => {
  it('returns 404 with NO_REPORT when none exists', async () => {
    mockedGetReport.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/admin/compass/validation/report')
;
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_REPORT');
  });

  it('returns the most recent report', async () => {
    mockedGetReport.mockResolvedValue({
      id: 'r-99',
      generatedAt: new Date(),
      windowResults: [],
      overallPassed: false,
      overallSummary: '3/4 passed.',
    });
    const res = await request(app)
      .get('/api/admin/compass/validation/report')
;
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('r-99');
    expect(res.body.overallPassed).toBe(false);
  });
});

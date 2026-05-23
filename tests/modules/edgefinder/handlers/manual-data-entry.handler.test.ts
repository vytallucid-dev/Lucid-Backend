import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('@modules/edgefinder/services/manual-data-entry.service', () => ({
  ingestManualEntry: vi.fn(),
}));

import { ingestManualEntry } from '@modules/edgefinder/services/manual-data-entry.service';
import { manualDataEntryHandler } from '@modules/edgefinder/handlers/manual-data-entry.handler';
import { AppError } from '@core/middleware/error-handler';

const mockedIngest = ingestManualEntry as unknown as ReturnType<typeof vi.fn>;

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (data: unknown) => MockRes;
}

function buildRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
  };
  return res;
}

function call(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ res: MockRes; err: unknown }> {
  const req = { body, headers } as unknown as Request;
  const res = buildRes();
  return new Promise((resolve) => {
    const next: NextFunction = (err?: unknown) => {
      resolve({ res, err });
    };
    void manualDataEntryHandler(req, res as unknown as Response, next).then(() => {
      if (res.statusCode !== 0) resolve({ res, err: undefined });
    });
  });
}

describe('manualDataEntryHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with full response shape on success', async () => {
    mockedIngest.mockResolvedValue({
      dataPointId: 'dp-1',
      action: 'inserted',
      indicator: { code: 'US_CPI_YOY', name: 'US CPI YoY' },
      observationDate: new Date('2026-04-01T00:00:00.000Z'),
      value: 3.5,
      isRateDecision: false,
      forecastValue: 3.4,
      previousValue: 3.2,
      notes: 'BLS April release',
    });

    const { res, err } = await call({
      indicatorCode: 'US_CPI_YOY',
      observationDate: '2026-04-01',
      actual: 3.5,
      forecast: 3.4,
      previous: 3.2,
      notes: 'BLS April release',
    });

    expect(err).toBeUndefined();
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.dataPointId).toBe('dp-1');
    expect(body.action).toBe('inserted');
    expect(body.observationDate).toBe('2026-04-01');
    expect(body.isRateDecision).toBe(false);
    expect(body.rateLevel).toBeUndefined();
    expect((body.metadata as Record<string, unknown>).forecastValue).toBe(3.4);
  });

  it('includes rateLevel in response for rate decisions', async () => {
    mockedIngest.mockResolvedValue({
      dataPointId: 'dp-fed',
      action: 'inserted',
      indicator: { code: 'US_FED_RATE', name: 'Fed Funds' },
      observationDate: new Date('2026-04-01T00:00:00.000Z'),
      value: 25,
      isRateDecision: true,
      rateLevel: 5.25,
      forecastValue: null,
      previousValue: null,
      notes: null,
    });

    const { res } = await call({
      indicatorCode: 'US_FED_RATE',
      observationDate: '2026-04-01',
      actual: 5.25,
    });

    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.rateLevel).toBe(5.25);
    expect(body.isRateDecision).toBe(true);
  });

  it('400 INVALID_BODY when indicatorCode missing', async () => {
    const { err } = await call({
      observationDate: '2026-04-01',
      actual: 3.5,
    });
    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.statusCode).toBe(400);
    expect(appErr.code).toBe('INVALID_BODY');
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it('400 INVALID_BODY when actual missing', async () => {
    const { err } = await call({
      indicatorCode: 'US_CPI_YOY',
      observationDate: '2026-04-01',
    });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('INVALID_BODY');
  });

  it('400 INVALID_BODY when actual is non-numeric', async () => {
    const { err } = await call({
      indicatorCode: 'US_CPI_YOY',
      observationDate: '2026-04-01',
      actual: 'three point five',
    });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('INVALID_BODY');
  });

  it('400 INVALID_BODY when date format is wrong (2026/05/01)', async () => {
    const { err } = await call({
      indicatorCode: 'US_CPI_YOY',
      observationDate: '2026/05/01',
      actual: 3.5,
    });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('INVALID_BODY');
  });

  it('400 OBSERVATION_DATE_INVALID when date is in the future', async () => {
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 30);
    const futureStr = future.toISOString().slice(0, 10);

    const { err } = await call({
      indicatorCode: 'US_CPI_YOY',
      observationDate: futureStr,
      actual: 3.5,
    });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('OBSERVATION_DATE_INVALID');
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it('forwards 404 INDICATOR_NOT_FOUND from service', async () => {
    mockedIngest.mockRejectedValue(
      new AppError(404, 'Indicator BOGUS not found', 'INDICATOR_NOT_FOUND'),
    );

    const { err } = await call({
      indicatorCode: 'BOGUS',
      observationDate: '2026-04-01',
      actual: 1,
    });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(404);
    expect((err as AppError).code).toBe('INDICATOR_NOT_FOUND');
  });

  it('forwards 400 INDICATOR_NOT_MANUAL_ELIGIBLE from service', async () => {
    mockedIngest.mockRejectedValue(
      new AppError(400, 'FRED indicator', 'INDICATOR_NOT_MANUAL_ELIGIBLE'),
    );

    const { err } = await call({
      indicatorCode: 'US_02Y_SMA',
      observationDate: '2026-04-01',
      actual: 1,
    });
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).code).toBe('INDICATOR_NOT_MANUAL_ELIGIBLE');
  });

  it('passes triggeredBy from x-admin-user header to service', async () => {
    mockedIngest.mockResolvedValue({
      dataPointId: 'dp-x',
      action: 'inserted',
      indicator: { code: 'US_CPI_YOY', name: 'US CPI YoY' },
      observationDate: new Date('2026-04-01T00:00:00.000Z'),
      value: 3.5,
      isRateDecision: false,
      forecastValue: null,
      previousValue: null,
      notes: null,
    });

    await call(
      {
        indicatorCode: 'US_CPI_YOY',
        observationDate: '2026-04-01',
        actual: 3.5,
      },
      { 'x-admin-user': 'alice@example.com' },
    );

    expect(mockedIngest).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: 'alice@example.com' }),
    );
  });
});

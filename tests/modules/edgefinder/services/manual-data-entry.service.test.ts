import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    indicator: { findUnique: vi.fn() },
    dataPoint: { findFirst: vi.fn() },
  },
}));

vi.mock('@core/repositories/data-points.repository', () => ({
  dataPointsRepository: {
    upsert: vi.fn(),
  },
}));

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: {
    start: vi.fn(),
    complete: vi.fn(),
  },
}));

import { prisma } from '@core/db/prisma';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import {
  ingestManualEntry,
  isRevisionMismatch,
} from '@modules/edgefinder/services/manual-data-entry.service';
import { AppError } from '@core/middleware/error-handler';

const mockedFindUnique = prisma.indicator.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = dataPointsRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedLogStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedLogComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;

const OBS_DATE = new Date('2026-04-01T00:00:00.000Z');

function baseInput(overrides: Partial<Parameters<typeof ingestManualEntry>[0]> = {}) {
  return {
    indicatorCode: 'US_CPI_YOY',
    observationDate: OBS_DATE,
    actual: 3.5,
    forecast: 3.4,
    previous: 3.2,
    notes: null as string | null,
    triggeredBy: null as string | null,
    ...overrides,
  };
}

describe('ingestManualEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLogStart.mockResolvedValue({ id: 'log-1' });
    mockedLogComplete.mockResolvedValue(undefined);
    mockedFindFirst.mockResolvedValue(null);
  });

  it('inserts a forex_factory indicator with all three values', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-cpi',
      code: 'US_CPI_YOY',
      name: 'US CPI YoY',
      dataSource: 'forex_factory',
    });
    mockedUpsert.mockResolvedValue({
      action: 'inserted',
      dataPoint: { id: 'dp-1' },
    });

    const result = await ingestManualEntry(baseInput());

    expect(result.action).toBe('inserted');
    expect(result.dataPointId).toBe('dp-1');
    expect(result.isRateDecision).toBe(false);
    expect(result.value).toBe(3.5);
    expect(result.forecastValue).toBe(3.4);
    expect(result.previousValue).toBe(3.2);
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.source).toBe('manual');
    expect(call.value).toBe(3.5);
    expect(call.forecastValue).toBe(3.4);
    expect(call.previousValue).toBe(3.2);
    expect((call.sourceMetadata as Record<string, unknown>).manualEntry).toBe(true);
  });

  it('inserts without forecast/previous (omitted → null)', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-cpi',
      code: 'US_CPI_YOY',
      name: 'US CPI YoY',
      dataSource: 'forex_factory',
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-2' } });

    await ingestManualEntry(baseInput({ forecast: null, previous: null }));

    const call = mockedUpsert.mock.calls[0][0];
    expect(call.forecastValue).toBeNull();
    expect(call.previousValue).toBeNull();
  });

  it('returns skipped when repository upsert returns skipped (idempotent re-entry)', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-cpi',
      code: 'US_CPI_YOY',
      name: 'US CPI YoY',
      dataSource: 'forex_factory',
    });
    mockedUpsert.mockResolvedValue({ action: 'skipped', dataPoint: { id: 'dp-3' } });

    const result = await ingestManualEntry(baseInput());
    expect(result.action).toBe('skipped');
    expect(mockedLogComplete).toHaveBeenCalledWith(
      expect.objectContaining({ rowsSkipped: 1, status: 'success' }),
    );
  });

  it('returns revised when repository upsert returns revised', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-cpi',
      code: 'US_CPI_YOY',
      name: 'US CPI YoY',
      dataSource: 'forex_factory',
    });
    mockedUpsert.mockResolvedValue({ action: 'revised', dataPoint: { id: 'dp-4' } });

    const result = await ingestManualEntry(baseInput({ actual: 3.6 }));
    expect(result.action).toBe('revised');
    expect(mockedLogComplete).toHaveBeenCalledWith(
      expect.objectContaining({ rowsUpdated: 1 }),
    );
  });

  it('rejects FRED-sourced indicator with INDICATOR_NOT_MANUAL_ELIGIBLE', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-fred',
      code: 'US_02Y_SMA',
      name: 'US 2Y SMA',
      dataSource: 'fred',
    });

    await expect(ingestManualEntry(baseInput({ indicatorCode: 'US_02Y_SMA' })))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'INDICATOR_NOT_MANUAL_ELIGIBLE',
      });
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('throws INDICATOR_NOT_FOUND for unknown code', async () => {
    mockedFindUnique.mockResolvedValue(null);

    await expect(ingestManualEntry(baseInput({ indicatorCode: 'BOGUS_CODE' })))
      .rejects.toMatchObject({
        statusCode: 404,
        code: 'INDICATOR_NOT_FOUND',
      });
  });

  it('rate decision, first release: bps_change=0, first_release=true, rate_level stored', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-fed',
      code: 'US_FED_RATE',
      name: 'US Fed Funds Rate',
      dataSource: 'forex_factory',
    });
    mockedFindFirst.mockResolvedValue(null);
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-fed' } });

    const result = await ingestManualEntry(
      baseInput({ indicatorCode: 'US_FED_RATE', actual: 5.0 }),
    );

    expect(result.isRateDecision).toBe(true);
    expect(result.rateLevel).toBe(5.0);
    expect(result.value).toBe(0);

    const call = mockedUpsert.mock.calls[0][0];
    expect(call.value).toBe(0);
    expect(call.forecastValue).toBeNull();
    expect(call.previousValue).toBeNull();
    const meta = call.sourceMetadata as Record<string, unknown>;
    expect(meta.rate_level).toBe(5.0);
    expect(meta.first_release).toBe(true);
    expect(meta.manualEntry).toBe(true);
  });

  it('rate decision with prior 5.00 → new 5.25: bps_change=25', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-fed',
      code: 'US_FED_RATE',
      name: 'US Fed Funds Rate',
      dataSource: 'forex_factory',
    });
    mockedFindFirst.mockResolvedValue({ sourceMetadata: { rate_level: 5.0 } });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-fed-2' } });

    const result = await ingestManualEntry(
      baseInput({ indicatorCode: 'US_FED_RATE', actual: 5.25 }),
    );

    expect(result.value).toBeCloseTo(25, 6);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.value).toBeCloseTo(25, 6);
    const meta = call.sourceMetadata as Record<string, unknown>;
    expect(meta.rate_level).toBe(5.25);
    expect(meta.first_release).toBeUndefined();
  });

  it('rate decision with prior 5.50 → new 5.25: bps_change=-25', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-fed',
      code: 'US_FED_RATE',
      name: 'US Fed Funds Rate',
      dataSource: 'forex_factory',
    });
    mockedFindFirst.mockResolvedValue({ sourceMetadata: { rate_level: 5.5 } });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-fed-3' } });

    const result = await ingestManualEntry(
      baseInput({ indicatorCode: 'US_FED_RATE', actual: 5.25 }),
    );

    expect(result.value).toBeCloseTo(-25, 6);
  });

  it('stores notes in sourceMetadata', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-cpi',
      code: 'US_CPI_YOY',
      name: 'US CPI YoY',
      dataSource: 'forex_factory',
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-notes' } });

    await ingestManualEntry(baseInput({ notes: 'BLS April 10 release' }));

    const call = mockedUpsert.mock.calls[0][0];
    expect((call.sourceMetadata as Record<string, unknown>).notes).toBe(
      'BLS April 10 release',
    );
    expect(call.notes).toBe('BLS April 10 release');
  });

  it('creates a fetch_log row and completes it on success', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-cpi',
      code: 'US_CPI_YOY',
      name: 'US CPI YoY',
      dataSource: 'forex_factory',
    });
    mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-log' } });

    await ingestManualEntry(baseInput());

    expect(mockedLogStart).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: 'manual_input_us_cpi_yoy',
        triggerType: 'manual',
      }),
    );
    expect(mockedLogComplete).toHaveBeenCalledWith(
      expect.objectContaining({ logId: 'log-1', status: 'success', rowsInserted: 1 }),
    );
  });

  it('does not throw AppError on FRED unless asserted explicitly', async () => {
    mockedFindUnique.mockResolvedValue({
      id: 'ind-fred',
      code: 'US_02Y_SMA',
      name: 'US 2Y SMA',
      dataSource: 'fred',
    });

    await expect(
      ingestManualEntry(baseInput({ indicatorCode: 'US_02Y_SMA' })),
    ).rejects.toBeInstanceOf(AppError);
  });

  // ── Revision detection ────────────────────────────────────────────────────
  describe('revision pre-check', () => {
    const CPI_INDICATOR = {
      id: 'ind-cpi',
      code: 'US_CPI_YOY',
      name: 'US CPI YoY',
      dataSource: 'forex_factory',
    };

    // The last stored actual the frontend auto-fills and the backend compares
    // `previous` against. Ordered observationDate-desc, isCurrent.
    function mockLastActual(value: number, date = '2026-05-01') {
      mockedFindFirst.mockResolvedValue({
        value,
        observationDate: new Date(`${date}T00:00:00.000Z`),
      });
    }

    // (a) match → writes normally, no interruption
    it('previous matches last stored actual → writes normally', async () => {
      mockedFindUnique.mockResolvedValue(CPI_INDICATOR);
      mockLastActual(3.9);
      mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-m' } });

      const result = await ingestManualEntry(baseInput({ actual: 4.1, previous: 3.9 }));

      expect(isRevisionMismatch(result)).toBe(false);
      expect(mockedUpsert).toHaveBeenCalledTimes(1);
      // No manual_revision_confirmed audit row on a clean match.
      const revisionLogged = mockedLogStart.mock.calls.some(
        (c) => c[0].jobName === 'manual_revision_confirmed',
      );
      expect(revisionLogged).toBe(false);
    });

    it('previous within float tolerance (0.0001) of stored actual → writes normally', async () => {
      mockedFindUnique.mockResolvedValue(CPI_INDICATOR);
      mockLastActual(3.9);
      mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-tol' } });

      const result = await ingestManualEntry(
        baseInput({ actual: 4.1, previous: 3.90005 }),
      );

      expect(isRevisionMismatch(result)).toBe(false);
      expect(mockedUpsert).toHaveBeenCalledTimes(1);
    });

    // (b) mismatch without flag → returns mismatch, writes nothing
    it('previous differs from stored actual, no confirmRevision → returns mismatch, writes nothing', async () => {
      mockedFindUnique.mockResolvedValue(CPI_INDICATOR);
      mockLastActual(3.9, '2026-05-12');

      const result = await ingestManualEntry(baseInput({ actual: 4.1, previous: 3.8 }));

      expect(isRevisionMismatch(result)).toBe(true);
      if (isRevisionMismatch(result)) {
        expect(result.requiresRevisionConfirmation).toBe(true);
        expect(result.indicatorCode).toBe('US_CPI_YOY');
        expect(result.storedActual).toBe(3.9);
        expect(result.storedActualDate).toBe('2026-05-12');
        expect(result.submittedPrevious).toBe(3.8);
      }
      // Nothing written, no fetch_log started at all.
      expect(mockedUpsert).not.toHaveBeenCalled();
      expect(mockedLogStart).not.toHaveBeenCalled();
    });

    // (c) mismatch with confirmRevision: true → writes, logs revision
    it('previous differs with confirmRevision: true → writes and logs manual_revision_confirmed', async () => {
      mockedFindUnique.mockResolvedValue(CPI_INDICATOR);
      mockLastActual(3.9, '2026-05-12');
      mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-rev' } });

      const result = await ingestManualEntry(
        baseInput({
          actual: 4.1,
          previous: 3.8,
          confirmRevision: true,
          triggeredBy: 'ajmix06@gmail.com',
        }),
      );

      expect(isRevisionMismatch(result)).toBe(false);
      expect(mockedUpsert).toHaveBeenCalledTimes(1);
      // The upsert wrote THIS month's row with the submitted previous unchanged.
      const upsertCall = mockedUpsert.mock.calls[0][0];
      expect(upsertCall.value).toBe(4.1);
      expect(upsertCall.previousValue).toBe(3.8);

      // A standalone manual_revision_confirmed audit row was written.
      const revisionStart = mockedLogStart.mock.calls.find(
        (c) => c[0].jobName === 'manual_revision_confirmed',
      );
      expect(revisionStart).toBeDefined();
      const meta = revisionStart![0].metadata as Record<string, unknown>;
      expect(meta.indicatorCode).toBe('US_CPI_YOY');
      expect(meta.storedActual).toBe(3.9);
      expect(meta.storedActualDate).toBe('2026-05-12');
      expect(meta.submittedPrevious).toBe(3.8);
      expect(meta.submittedActual).toBe(4.1);
      expect(meta.user).toBe('ajmix06@gmail.com');
      expect(revisionStart![0].triggeredBy).toBe('ajmix06@gmail.com');
    });

    // (d) no prior data point → no pre-fill / no mismatch check, writes normally
    it('no prior data point → skips mismatch check, writes normally', async () => {
      mockedFindUnique.mockResolvedValue(CPI_INDICATOR);
      mockedFindFirst.mockResolvedValue(null); // no last actual
      mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-first' } });

      const result = await ingestManualEntry(baseInput({ actual: 4.1, previous: 3.8 }));

      expect(isRevisionMismatch(result)).toBe(false);
      expect(mockedUpsert).toHaveBeenCalledTimes(1);
    });

    it('no `previous` submitted → skips mismatch check even when stored actual differs', async () => {
      mockedFindUnique.mockResolvedValue(CPI_INDICATOR);
      mockLastActual(3.9);
      mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: { id: 'dp-noprev' } });

      const result = await ingestManualEntry(
        baseInput({ actual: 4.1, previous: null }),
      );

      expect(isRevisionMismatch(result)).toBe(false);
      expect(mockedUpsert).toHaveBeenCalledTimes(1);
    });
  });
});

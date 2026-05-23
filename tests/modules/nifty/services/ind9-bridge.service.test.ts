import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    indicator: { findUnique: vi.fn() },
  },
}));

vi.mock('@core/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@core/repositories/data-points.repository', () => ({
  dataPointsRepository: { upsert: vi.fn() },
}));

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: { start: vi.fn(), complete: vi.fn() },
}));

vi.mock('@modules/edgefinder/services/scorecard/scorecard-export.service', () => ({
  getLatestUsdBaseFundamentals: vi.fn(),
}));

import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { getLatestUsdBaseFundamentals } from '@modules/edgefinder/services/scorecard/scorecard-export.service';
import { runInd9Bridge } from '@modules/nifty/services/ind9-bridge.service';

const mockedIndicatorFindUnique = prisma.indicator.findUnique as ReturnType<typeof vi.fn>;
const mockedLogWarn = logger.warn as ReturnType<typeof vi.fn>;
const mockedUpsert = dataPointsRepository.upsert as ReturnType<typeof vi.fn>;
const mockedLogStart = dataFetchLogRepository.start as ReturnType<typeof vi.fn>;
const mockedLogComplete = dataFetchLogRepository.complete as ReturnType<typeof vi.fn>;
const mockedGetLatestUsd = getLatestUsdBaseFundamentals as ReturnType<typeof vi.fn>;

const TODAY = new Date(Date.UTC(2026, 4, 19));
const YESTERDAY = new Date(Date.UTC(2026, 4, 18));

const USD_EXPORT_TODAY = {
  observationDate: TODAY,
  baseFundamentalsScore: -5,
  indicatorBreakdown: { GDP: 1, CPI: -1 },
  isToday: true,
};

const IND9_INDICATOR = { id: 'ind-9', code: 'IND_NIFTY_09_USD_WEAKNESS' };

beforeEach(() => {
  vi.clearAllMocks();
  mockedLogStart.mockResolvedValue({ id: 'log-1' });
  mockedLogComplete.mockResolvedValue(undefined);
  mockedGetLatestUsd.mockResolvedValue(USD_EXPORT_TODAY);
  mockedIndicatorFindUnique.mockResolvedValue(IND9_INDICATOR);
  mockedUpsert.mockResolvedValue({ action: 'inserted', dataPoint: {} });
});

describe('runInd9Bridge', () => {
  it('writes rawSum (baseFundamentalsScore) to data_points.value, not a thresholded score', async () => {
    const result = await runInd9Bridge('cron', null, TODAY);
    expect(result.status).toBe('success');
    expect(result.rawSum).toBe(-5);
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ value: -5 }),
    );
  });

  it('returns success with correct fields when scorecard is for today', async () => {
    const result = await runInd9Bridge('cron', null, TODAY);
    expect(result.status).toBe('success');
    expect(result.rawSum).toBe(-5);
    expect(result.isStaleScorecard).toBe(false);
    expect(result.action).toBe('inserted');
    expect(result.usdScorecardDate?.getTime()).toBe(TODAY.getTime());
  });

  it('returns success with isStaleScorecard=true and logs WARN when scorecard is from yesterday', async () => {
    mockedGetLatestUsd.mockResolvedValue({
      ...USD_EXPORT_TODAY,
      observationDate: YESTERDAY,
      isToday: false,
    });
    const result = await runInd9Bridge('cron', null, TODAY);
    expect(result.status).toBe('success');
    expect(result.isStaleScorecard).toBe(true);
    expect(result.usdScorecardDate?.getTime()).toBe(YESTERDAY.getTime());
    expect(mockedLogWarn).toHaveBeenCalledTimes(1);
  });

  it('returns failed with reason no_usd_scorecard when USD export returns null', async () => {
    mockedGetLatestUsd.mockResolvedValue(null);
    const result = await runInd9Bridge('cron', null, TODAY);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('no_usd_scorecard');
    expect(mockedUpsert).not.toHaveBeenCalled();
    expect(mockedLogComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('returns failed with reason indicator_not_found when IND_NIFTY_09_USD_WEAKNESS is missing', async () => {
    mockedIndicatorFindUnique.mockResolvedValue(null);
    const result = await runInd9Bridge('cron', null, TODAY);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('indicator_not_found');
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('returns action skipped when re-run with unchanged rawSum (idempotent)', async () => {
    mockedUpsert.mockResolvedValue({ action: 'skipped', dataPoint: {} });
    const result = await runInd9Bridge('cron', null, TODAY);
    expect(result.status).toBe('success');
    expect(result.action).toBe('skipped');
    expect(mockedLogComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', rowsSkipped: 1 }),
    );
  });

  it('sourceMetadata contains usdScorecardDate, isStaleScorecard, indicatorBreakdown, bridgeVersion', async () => {
    await runInd9Bridge('cron', null, TODAY);
    const upsertCall = mockedUpsert.mock.calls[0][0] as {
      sourceMetadata: Record<string, unknown>;
    };
    const meta = upsertCall.sourceMetadata;
    expect(meta).toHaveProperty('usdScorecardDate', '2026-05-19');
    expect(meta).toHaveProperty('isStaleScorecard', false);
    expect(meta).toHaveProperty('indicatorBreakdown', { GDP: 1, CPI: -1 });
    expect(meta).toHaveProperty('bridgeVersion', 'v1');
    expect(meta).not.toHaveProperty('rawSumOf14');
    expect(meta).not.toHaveProperty('thresholdApplied');
  });

  it('writes source=derived to data_points', async () => {
    await runInd9Bridge('cron', null, TODAY);
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'derived' }),
    );
  });

  it('starts and completes a data_fetch_log entry with correct job metadata', async () => {
    await runInd9Bridge('cron', 'admin', TODAY);
    expect(mockedLogStart).toHaveBeenCalledTimes(1);
    expect(mockedLogStart.mock.calls[0][0].jobName).toBe('nifty_ind9_bridge');
    expect(mockedLogStart.mock.calls[0][0].triggerType).toBe('cron');
    expect(mockedLogStart.mock.calls[0][0].triggeredBy).toBe('admin');
    expect(mockedLogComplete).toHaveBeenCalledTimes(1);
  });
});

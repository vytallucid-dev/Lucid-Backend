import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: {
    start: vi.fn(),
    complete: vi.fn(),
  },
}));

vi.mock('@modules/edgefinder/services/scorecard/asset-scorecard.service', () => ({
  assembleAssetScorecard: vi.fn(),
}));

import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { assembleAssetScorecard } from '@modules/edgefinder/services/scorecard/asset-scorecard.service';
import { runScorecardOrchestrator } from '@modules/edgefinder/services/scorecard/scorecard-orchestrator.service';

const mockedStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;
const mockedAssemble = assembleAssetScorecard as unknown as ReturnType<typeof vi.fn>;

const DATE = new Date(Date.UTC(2026, 4, 19));

beforeEach(() => {
  vi.clearAllMocks();
  mockedStart.mockResolvedValue({ id: 'log-1' });
  mockedComplete.mockResolvedValue(undefined);
  mockedAssemble.mockResolvedValue({
    scorecardId: 'sc-1',
    action: 'inserted',
    totalScore: 0,
    ratingLabel: 'Neutral',
  });
});

describe('runScorecardOrchestrator', () => {
  it('runs all 5 assets and returns success when all succeed', async () => {
    const r = await runScorecardOrchestrator('manual', null, DATE);
    expect(r.status).toBe('success');
    expect(r.assetsSucceeded.sort()).toEqual(['EUR', 'GBP', 'JPY', 'USD', 'XAUUSD']);
    expect(r.assetsFailed).toHaveLength(0);
    expect(mockedAssemble).toHaveBeenCalledTimes(5);
    expect(mockedComplete).toHaveBeenCalledTimes(1);
    expect(mockedComplete.mock.calls[0][0].status).toBe('success');
  });

  it('returns partial when some assets fail', async () => {
    mockedAssemble.mockImplementation(async (assetCode: string) => {
      if (assetCode === 'EUR') throw new Error('boom');
      return { scorecardId: 'sc-1', action: 'inserted' };
    });
    const r = await runScorecardOrchestrator('cron', null, DATE);
    expect(r.status).toBe('partial');
    expect(r.assetsFailed[0].assetCode).toBe('EUR');
    expect(r.assetsFailed[0].error).toBe('boom');
    expect(r.assetsSucceeded).toHaveLength(4);
  });

  it('returns failed when all assets fail', async () => {
    mockedAssemble.mockRejectedValue(new Error('db down'));
    const r = await runScorecardOrchestrator('cron', null, DATE);
    expect(r.status).toBe('failed');
    expect(r.assetsSucceeded).toHaveLength(0);
    expect(r.assetsFailed).toHaveLength(5);
    expect(mockedComplete.mock.calls[0][0].status).toBe('failed');
  });

  it('writes a data_fetch_log row with the correct job name', async () => {
    await runScorecardOrchestrator('cron', 'admin', DATE);
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(mockedStart.mock.calls[0][0].jobName).toBe('edgefinder_scorecard_assembly');
    expect(mockedStart.mock.calls[0][0].triggerType).toBe('cron');
    expect(mockedStart.mock.calls[0][0].triggeredBy).toBe('admin');
  });

  it('passes the forDate to assembleAssetScorecard', async () => {
    const backfillDate = new Date(Date.UTC(2026, 3, 1));
    await runScorecardOrchestrator('manual', null, backfillDate);
    expect(mockedAssemble.mock.calls[0][1].getTime()).toBe(backfillDate.getTime());
  });
});

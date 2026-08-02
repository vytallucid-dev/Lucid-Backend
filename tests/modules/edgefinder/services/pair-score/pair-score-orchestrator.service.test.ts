import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: {
    start: vi.fn(),
    complete: vi.fn(),
  },
}));

vi.mock('@modules/edgefinder/services/pair-score/pair-score.service', () => ({
  assemblePairScore: vi.fn(),
}));

// Phase 2: the pair universe is derived from the asset registry rather than a
// hardcoded PAIR_DEFINITIONS array, so the orchestrator calls into the config
// module. Mocked to keep the test hermetic.
const registryPairs: Array<{ code: string; base: string; quote: string }> = [];

vi.mock('@modules/edgefinder/services/pair-score/pair-template.config', () => ({
  loadPairDefinitions: vi.fn(async () => registryPairs),
}));

import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { assemblePairScore } from '@modules/edgefinder/services/pair-score/pair-score.service';
import { runPairScoreOrchestrator } from '@modules/edgefinder/services/pair-score/pair-score-orchestrator.service';

const mockedStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;
const mockedAssemble = assemblePairScore as unknown as ReturnType<typeof vi.fn>;

const DATE = new Date(Date.UTC(2026, 4, 19));

beforeEach(() => {
  vi.clearAllMocks();
  registryPairs.length = 0;
  registryPairs.push(
    { code: 'EURUSD', base: 'EUR', quote: 'USD' },
    { code: 'GBPUSD', base: 'GBP', quote: 'USD' },
    { code: 'USDJPY', base: 'USD', quote: 'JPY' },
    { code: 'EURJPY', base: 'EUR', quote: 'JPY' },
    { code: 'GBPJPY', base: 'GBP', quote: 'JPY' },
  );
  mockedStart.mockResolvedValue({ id: 'log-1' });
  mockedComplete.mockResolvedValue(undefined);
  mockedAssemble.mockResolvedValue({
    pairScoreId: 'ps-1',
    action: 'inserted',
    totalScore: 0,
    ratingLabel: 'Neutral',
  });
});

describe('runPairScoreOrchestrator', () => {
  it('picks up a newly registered pair with no code change', async () => {
    registryPairs.push({ code: 'AUDUSD', base: 'AUD', quote: 'USD' });
    const r = await runPairScoreOrchestrator('manual', null, DATE);
    expect(r.pairsSucceeded).toContain('AUDUSD');
    expect(mockedAssemble).toHaveBeenCalledTimes(6);
  });

  it('runs all 5 pairs and returns success when all succeed', async () => {
    const r = await runPairScoreOrchestrator('manual', null, DATE);
    expect(r.status).toBe('success');
    expect(r.pairsSucceeded.sort()).toEqual(['EURJPY', 'EURUSD', 'GBPJPY', 'GBPUSD', 'USDJPY']);
    expect(r.pairsFailed).toHaveLength(0);
    expect(mockedAssemble).toHaveBeenCalledTimes(5);
    expect(mockedComplete).toHaveBeenCalledTimes(1);
    expect(mockedComplete.mock.calls[0][0].status).toBe('success');
  });

  it('returns partial when some pairs fail', async () => {
    mockedAssemble.mockImplementation(async (pairCode: string) => {
      if (pairCode === 'EURJPY') throw new Error('cot missing');
      return { pairScoreId: 'ps-1', action: 'inserted' };
    });
    const r = await runPairScoreOrchestrator('cron', null, DATE);
    expect(r.status).toBe('partial');
    expect(r.pairsFailed[0].pairCode).toBe('EURJPY');
    expect(r.pairsFailed[0].error).toBe('cot missing');
    expect(r.pairsSucceeded).toHaveLength(4);
  });

  it('returns failed when all pairs fail', async () => {
    mockedAssemble.mockRejectedValue(new Error('db down'));
    const r = await runPairScoreOrchestrator('cron', null, DATE);
    expect(r.status).toBe('failed');
    expect(r.pairsSucceeded).toHaveLength(0);
    expect(r.pairsFailed).toHaveLength(5);
    expect(mockedComplete.mock.calls[0][0].status).toBe('failed');
  });

  it('writes a data_fetch_log row with the correct job name', async () => {
    await runPairScoreOrchestrator('cron', 'admin', DATE);
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(mockedStart.mock.calls[0][0].jobName).toBe('edgefinder_pair_score_assembly');
    expect(mockedStart.mock.calls[0][0].triggerType).toBe('cron');
    expect(mockedStart.mock.calls[0][0].triggeredBy).toBe('admin');
  });

  it('passes the forDate through to assemblePairScore', async () => {
    const backfill = new Date(Date.UTC(2026, 3, 1));
    await runPairScoreOrchestrator('manual', null, backfill);
    expect(mockedAssemble.mock.calls[0][1].getTime()).toBe(backfill.getTime());
  });
});

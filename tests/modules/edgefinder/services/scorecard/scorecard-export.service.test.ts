import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    asset: { findFirst: vi.fn() },
    edgefinderScorecard: { findFirst: vi.fn() },
  },
}));

vi.mock('@core/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { getLatestUsdBaseFundamentals } from '@modules/edgefinder/services/scorecard/scorecard-export.service';

const mockedAssetFindFirst = prisma.asset.findFirst as ReturnType<typeof vi.fn>;
const mockedScorecardFindFirst = prisma.edgefinderScorecard.findFirst as ReturnType<typeof vi.fn>;
const mockedLogError = logger.error as ReturnType<typeof vi.fn>;
const mockedLogWarn = logger.warn as ReturnType<typeof vi.fn>;

const TODAY = new Date(Date.UTC(2026, 4, 19)); // 2026-05-19
const YESTERDAY = new Date(Date.UTC(2026, 4, 18)); // 2026-05-18

const USD_ASSET = { id: 'asset-usd', code: 'USD' };
const SCORECARD_TODAY = {
  id: 'sc-1',
  assetId: 'asset-usd',
  observationDate: TODAY,
  baseFundamentalsScore: -5,
  indicatorBreakdown: { GDP: 1, CPI: -1 },
  isCurrent: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedAssetFindFirst.mockResolvedValue(USD_ASSET);
  mockedScorecardFindFirst.mockResolvedValue(SCORECARD_TODAY);
});

describe('getLatestUsdBaseFundamentals', () => {
  it('returns today scorecard with isToday=true when scorecard matches today', async () => {
    const result = await getLatestUsdBaseFundamentals(TODAY);
    expect(result).not.toBeNull();
    expect(result!.isToday).toBe(true);
    expect(result!.baseFundamentalsScore).toBe(-5);
    expect(result!.observationDate.getTime()).toBe(TODAY.getTime());
    expect(result!.indicatorBreakdown).toEqual({ GDP: 1, CPI: -1 });
  });

  it('returns yesterday scorecard with isToday=false when no scorecard exists for today', async () => {
    mockedScorecardFindFirst.mockResolvedValue({ ...SCORECARD_TODAY, observationDate: YESTERDAY });
    const result = await getLatestUsdBaseFundamentals(TODAY);
    expect(result).not.toBeNull();
    expect(result!.isToday).toBe(false);
    expect(result!.observationDate.getTime()).toBe(YESTERDAY.getTime());
  });

  it('returns null and logs error when USD asset is not found in EdgeFinder scope', async () => {
    mockedAssetFindFirst.mockResolvedValue(null);
    const result = await getLatestUsdBaseFundamentals(TODAY);
    expect(result).toBeNull();
    expect(mockedLogError).toHaveBeenCalledTimes(1);
    expect(mockedScorecardFindFirst).not.toHaveBeenCalled();
  });

  it('returns null and logs warn when no USD scorecards exist at all', async () => {
    mockedScorecardFindFirst.mockResolvedValue(null);
    const result = await getLatestUsdBaseFundamentals(TODAY);
    expect(result).toBeNull();
    expect(mockedLogWarn).toHaveBeenCalledTimes(1);
  });

  it('only queries for isCurrent=true scorecards, ordered by observationDate desc', async () => {
    await getLatestUsdBaseFundamentals(TODAY);
    expect(mockedScorecardFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isCurrent: true }),
        orderBy: { observationDate: 'desc' },
      }),
    );
  });
});

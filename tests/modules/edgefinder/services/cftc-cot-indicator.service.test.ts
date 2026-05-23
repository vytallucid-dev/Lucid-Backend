import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { CftcLegacyRow } from '@core/clients/cftc/types';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    asset: { findMany: vi.fn() },
  },
}));

vi.mock('@core/clients/cftc/cftc.client', () => ({
  cftcClient: { fetchRecentLegacyData: vi.fn() },
}));

vi.mock('@core/repositories/cot-data.repository', () => ({
  cotDataRepository: { upsert: vi.fn() },
}));

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: {
    start: vi.fn(),
    complete: vi.fn(),
  },
}));

import { prisma } from '@core/db/prisma';
import { cftcClient } from '@core/clients/cftc/cftc.client';
import { cotDataRepository } from '@core/repositories/cot-data.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { fetchCftcCotData } from '@modules/edgefinder/services/cftc-cot-indicator.service';

const mockedFindMany = prisma.asset.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedFetch = cftcClient.fetchRecentLegacyData as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = cotDataRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedLogStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedLogComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;

function makeRow(partial: Partial<CftcLegacyRow>): CftcLegacyRow {
  return {
    market_and_exchange_names: 'USD INDEX - ICE FUTURES U.S.',
    report_date_as_yyyy_mm_dd: '2026-05-13T00:00:00.000',
    cftc_contract_market_code: '098662',
    noncomm_positions_long_all: '40000',
    noncomm_positions_short_all: '30000',
    change_in_noncomm_long_all: '1000',
    change_in_noncomm_short_all: '-500',
    ...partial,
  };
}

const EDGEFINDER_ASSETS = [
  {
    id: 'asset-usd',
    metadata: { cotContractCode: '098662', cotTraderCategory: 'Non-Commercials' },
  },
  {
    id: 'asset-eur',
    metadata: { cotContractCode: '099741', cotTraderCategory: 'Non-Commercials' },
  },
  {
    id: 'asset-gbp',
    metadata: { cotContractCode: '096742', cotTraderCategory: 'Non-Commercials' },
  },
  {
    id: 'asset-jpy',
    metadata: { cotContractCode: '097741', cotTraderCategory: 'Non-Commercials' },
  },
  {
    id: 'asset-xau',
    metadata: { cotContractCode: '088691', cotTraderCategory: 'Non-Commercials' },
  },
];

describe('fetchCftcCotData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLogStart.mockResolvedValue({ id: 'log-cot-1' });
    mockedLogComplete.mockResolvedValue(undefined);
    mockedFindMany.mockResolvedValue(EDGEFINDER_ASSETS);
    mockedUpsert.mockResolvedValue({ cotDataId: 'cot-row-1', action: 'inserted' });
  });

  it('upserts all 5 matching contract rows', async () => {
    mockedFetch.mockResolvedValue({
      rows: [
        makeRow({ cftc_contract_market_code: '098662' }),
        makeRow({ cftc_contract_market_code: '099741' }),
        makeRow({ cftc_contract_market_code: '096742' }),
        makeRow({ cftc_contract_market_code: '097741' }),
        makeRow({ cftc_contract_market_code: '088691' }),
      ],
      fetchedAt: new Date(),
      requestUrl: 'https://publicreporting.cftc.gov/resource/6dca-aqww.json',
      totalRowsReturned: 5,
    });

    const result = await fetchCftcCotData('manual', null);

    expect(result.status).toBe('success');
    expect(result.totalRowsFetched).toBe(5);
    expect(result.matchedAssetsCount).toBe(5);
    expect(result.unmatchedRowsCount).toBe(0);
    expect(result.rowsInserted).toBe(5);
    expect(mockedUpsert).toHaveBeenCalledTimes(5);
  });

  it('counts unmatched rows separately from matched ones', async () => {
    mockedFetch.mockResolvedValue({
      rows: [
        makeRow({ cftc_contract_market_code: '098662' }),
        makeRow({ cftc_contract_market_code: '099741' }),
        makeRow({ cftc_contract_market_code: 'XXXXXX' }),
        makeRow({ cftc_contract_market_code: 'YYYYYY' }),
      ],
      fetchedAt: new Date(),
      requestUrl: '',
      totalRowsReturned: 4,
    });

    const result = await fetchCftcCotData('manual', null);

    expect(result.matchedAssetsCount).toBe(2);
    expect(result.unmatchedRowsCount).toBe(2);
    expect(mockedUpsert).toHaveBeenCalledTimes(2);
  });

  it('skips rows with unparseable numeric fields', async () => {
    mockedFetch.mockResolvedValue({
      rows: [
        makeRow({
          cftc_contract_market_code: '098662',
          noncomm_positions_long_all: undefined,
        }),
      ],
      fetchedAt: new Date(),
      requestUrl: '',
      totalRowsReturned: 1,
    });

    const result = await fetchCftcCotData('manual', null);

    expect(result.rowsSkipped).toBe(1);
    expect(result.matchedAssetsCount).toBe(0);
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('computes labels per Step B helpers and forwards them to upsert', async () => {
    mockedFetch.mockResolvedValue({
      rows: [
        makeRow({
          cftc_contract_market_code: '098662',
          noncomm_positions_long_all: '60000',
          noncomm_positions_short_all: '40000',
          change_in_noncomm_long_all: '2000',
          change_in_noncomm_short_all: '-1000',
        }),
      ],
      fetchedAt: new Date(),
      requestUrl: '',
      totalRowsReturned: 1,
    });

    await fetchCftcCotData('manual', null);

    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    const call = mockedUpsert.mock.calls[0][0];
    // 60000 / 100000 = 60% → Bullish
    expect(call.netPositioningLabel).toBe('Bullish');
    // change_long_pct = 2000/58000 ≈ 3.448, change_short_pct = -1000/41000 ≈ -2.439
    // weekly = 5.887 > 0.5 → Bullish
    expect(call.changeLabel).toBe('Bullish');
    expect(call.traderCategory).toBe('Non-Commercials');
    expect(call.source).toBe('cftc');
    expect(call.assetId).toBe('asset-usd');
    expect((call.reportDate as Date).toISOString()).toBe('2026-05-13T00:00:00.000Z');
    expect((call.releaseDate as Date).toISOString()).toBe('2026-05-16T00:00:00.000Z');
  });

  it('creates and completes a data_fetch_log row', async () => {
    mockedFetch.mockResolvedValue({
      rows: [makeRow({ cftc_contract_market_code: '098662' })],
      fetchedAt: new Date(),
      requestUrl: '',
      totalRowsReturned: 1,
    });

    const result = await fetchCftcCotData('cron', null);

    expect(mockedLogStart).toHaveBeenCalledTimes(1);
    const startArgs = mockedLogStart.mock.calls[0][0];
    expect(startArgs.jobName).toBe('cftc_cot_weekly_fetch');
    expect(startArgs.triggerType).toBe('cron');

    expect(mockedLogComplete).toHaveBeenCalledTimes(1);
    expect(mockedLogComplete.mock.calls[0][0].logId).toBe('log-cot-1');
    expect(result.logId).toBe('log-cot-1');
  });

  it('marks status=failed when the fetch itself throws', async () => {
    mockedFetch.mockRejectedValue(new Error('boom'));

    const result = await fetchCftcCotData('manual', null);

    expect(result.status).toBe('failed');
    expect(result.errors).toHaveLength(1);
    expect(mockedLogComplete).toHaveBeenCalledTimes(1);
    expect(mockedLogComplete.mock.calls[0][0].status).toBe('failed');
  });
});

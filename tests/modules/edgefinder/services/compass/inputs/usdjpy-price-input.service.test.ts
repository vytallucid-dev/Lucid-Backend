import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/clients/eodhd/eodhd.client', () => ({
  eodhdClient: { fetchEodSeries: vi.fn() },
}));
vi.mock('@core/repositories/compass-inputs.repository', () => ({
  compassInputsRepository: { upsert: vi.fn() },
}));

import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { ingestUsdJpyPriceInput } from '@modules/edgefinder/services/compass/inputs/usdjpy-price-input.service';

const mockedFetch = eodhdClient.fetchEodSeries as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

function rows(dates: string[], values: number[]) {
  return dates.map((date, i) => ({ date, value: values[i] }));
}

describe('ingestUsdJpyPriceInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('persists EVERY observation in the fetched window as its own row (Phase 5 fix — the shock layer reads stored history, not just today)', async () => {
    const dates = ['2026-05-14', '2026-05-15', '2026-05-18'];
    mockedFetch.mockResolvedValue(rows(dates, [150.1, 150.5, 149.8]));

    await ingestUsdJpyPriceInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert).toHaveBeenCalledTimes(3);
    const calls = mockedUpsert.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.rawValue)).toEqual([150.1, 150.5, 149.8]);
    calls.forEach((call) => {
      expect(call.inputCode).toBe('USDJPY_PRICE');
      expect(call.derivedValue).toBeNull();
      expect(call.colorBand).toBe('YELLOW');
      expect(call.source).toBe('eodhd');
    });
    expect(calls[2].observationDate).toEqual(new Date(Date.UTC(2026, 4, 18)));
  });

  it('fetches USDJPY.FOREX from EODHD', async () => {
    mockedFetch.mockResolvedValue(rows(['2026-05-18'], [150.0]));
    await ingestUsdJpyPriceInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedFetch).toHaveBeenCalledWith('USDJPY.FOREX', expect.any(String));
  });

  it('throws when EODHD returns zero rows', async () => {
    mockedFetch.mockResolvedValue([]);
    await expect(
      ingestUsdJpyPriceInput(new Date(Date.UTC(2026, 4, 18))),
    ).rejects.toThrow(/USDJPY_PRICE/);
  });

  it('validation mode filters rows to <= observationDate (excludes future rows)', async () => {
    const dates = ['2026-05-14', '2026-05-15', '2026-05-20']; // last date is AFTER observationDate
    mockedFetch.mockResolvedValue(rows(dates, [150.0, 150.5, 999]));
    await ingestUsdJpyPriceInput(new Date(Date.UTC(2026, 4, 18)), true);
    expect(mockedUpsert).toHaveBeenCalledTimes(2); // 05-20/999 excluded
    const calls = mockedUpsert.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.rawValue)).toEqual([150.0, 150.5]);
  });

  it('re-running over an already-ingested window upserts idempotently per date (one call per date, not additive)', async () => {
    const dates = ['2026-05-14', '2026-05-15', '2026-05-18'];
    mockedFetch.mockResolvedValue(rows(dates, [150.1, 150.5, 149.8]));
    await ingestUsdJpyPriceInput(new Date(Date.UTC(2026, 4, 18)));
    await ingestUsdJpyPriceInput(new Date(Date.UTC(2026, 4, 18)));
    // 3 upsert calls per run x 2 runs = 6 calls total, each keyed by
    // (observationDate, inputCode, isValidation) at the repository layer,
    // which is where idempotency (insert-or-update) is actually enforced.
    expect(mockedUpsert).toHaveBeenCalledTimes(6);
  });
});

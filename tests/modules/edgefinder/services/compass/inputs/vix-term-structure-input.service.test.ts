import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/clients/eodhd/eodhd.client', () => ({
  eodhdClient: { fetchEodSeries: vi.fn() },
}));
vi.mock('@core/repositories/compass-inputs.repository', () => ({
  compassInputsRepository: { upsert: vi.fn() },
}));

import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { ingestVixTermStructureInput } from '@modules/edgefinder/services/compass/inputs/vix-term-structure-input.service';
import { COMPASS_CONFIG_V1_FIXTURE as cfg } from '../compass-config.fixture';

const mockedFetch = eodhdClient.fetchEodSeries as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

function rows(dates: string[], values: number[]) {
  return dates.map((date, i) => ({ date, value: values[i] }));
}

describe('ingestVixTermStructureInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('GREEN in normal contango (ts_ratio well below 0.90)', async () => {
    const dates = ['2026-05-14', '2026-05-15', '2026-05-18'];
    mockedFetch
      .mockResolvedValueOnce(rows(dates, [15, 16, 17])) // VIX
      .mockResolvedValueOnce(rows(dates, [18, 19, 20])); // VIX3M — ratio = 17/20 = 0.85

    await ingestVixTermStructureInput(new Date(Date.UTC(2026, 4, 18)), cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.inputCode).toBe('VIX_TERM_STRUCTURE');
    expect(call.rawValue).toBeCloseTo(0.85, 6);
    expect(call.colorBand).toBe('GREEN');
    expect(call.source).toBe('derived');
  });

  it('RED in backwardation (ts_ratio > 1.00)', async () => {
    const dates = ['2026-05-14', '2026-05-15', '2026-05-18'];
    mockedFetch
      .mockResolvedValueOnce(rows(dates, [30, 31, 32])) // VIX
      .mockResolvedValueOnce(rows(dates, [25, 26, 28])); // VIX3M — ratio = 32/28 ≈ 1.143

    await ingestVixTermStructureInput(new Date(Date.UTC(2026, 4, 18)), cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('[case 1] forward-fills VIX3M when its observation for today is missing (1-day gap, within the 3-day limit) — scores normally, NOT yellow', async () => {
    const vixDates = ['2026-05-14', '2026-05-15', '2026-05-18']; // Thu, Fri, Mon
    const vix3mDates = ['2026-05-14', '2026-05-15']; // missing the 05-18 observation date
    mockedFetch
      .mockResolvedValueOnce(rows(vixDates, [15, 16, 17]))
      .mockResolvedValueOnce(rows(vix3mDates, [18, 19]));

    await ingestVixTermStructureInput(new Date(Date.UTC(2026, 4, 18)), cfg);
    const call = mockedUpsert.mock.calls[0][0];
    // 17 (VIX today) / 19 (VIX3M forward-filled from 05-15) ≈ 0.895 — still GREEN.
    expect(call.colorBand).not.toBe('YELLOW');
    expect(call.rawValue).toBeCloseTo(17 / 19, 6);
  });

  it('[case 3] YELLOW when VIX3M is stale beyond the 3-day market-data limit (does not throw)', async () => {
    const vixDates = ['2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-18'];
    const vix3mDates = ['2026-05-12']; // 4 trading days stale as of 05-18 (13,14,15,18 all missing)
    mockedFetch
      .mockResolvedValueOnce(rows(vixDates, [15, 15.5, 16, 16.5, 17]))
      .mockResolvedValueOnce(rows(vix3mDates, [18]));

    await ingestVixTermStructureInput(new Date(Date.UTC(2026, 4, 18)), cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('YELLOW');
    expect(call.rawValue).toBeNull();
    expect(call.subChecks.vix3mStale).toBe(true);
  });

  it('YELLOW when EODHD returns zero rows on one side (does not throw)', async () => {
    mockedFetch.mockResolvedValueOnce([]).mockResolvedValueOnce(rows(['2026-05-18'], [19]));
    await ingestVixTermStructureInput(new Date(Date.UTC(2026, 4, 18)), cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('YELLOW');
    expect(call.subChecks.insufficientHistory).toBe(true);
  });
});

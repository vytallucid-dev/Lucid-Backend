import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/clients/eodhd/eodhd.client', () => ({
  eodhdClient: { fetchEodSeries: vi.fn() },
}));
vi.mock('@core/repositories/compass-inputs.repository', () => ({
  compassInputsRepository: { upsert: vi.fn() },
}));

import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { ingestVixInput } from '@modules/edgefinder/services/compass/inputs/vix-input.service';
import { COMPASS_CONFIG_V1_FIXTURE as cfg } from '../compass-config.fixture';

const mockedFetch = eodhdClient.fetchEodSeries as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

const OBS_DATE = new Date(Date.UTC(2026, 4, 18)); // Monday

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function buildWeekdayRows(values: number[], endDate: Date = OBS_DATE): { date: string; value: number }[] {
  const dates: Date[] = [];
  const cursor = new Date(endDate);
  while (dates.length < values.length) {
    if (!isWeekend(cursor)) dates.unshift(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.map((d, i) => ({ date: d.toISOString().slice(0, 10), value: values[i] }));
}

describe('ingestVixInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('upserts GREEN row when 5-day avg below 18', async () => {
    mockedFetch.mockResolvedValue(buildWeekdayRows([15, 16, 17, 16.5, 16]));
    await ingestVixInput(OBS_DATE, cfg);

    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.inputCode).toBe('VIX_5D_AVG');
    expect(call.rawValue).toBe(16);
    expect(call.derivedValue).toBeCloseTo(16.1, 6);
    expect(call.colorBand).toBe('GREEN');
    expect(call.source).toBe('eodhd');
  });

  it('upserts RED row when 5-day avg above 25', async () => {
    mockedFetch.mockResolvedValue(buildWeekdayRows([28, 29, 30, 31, 32]));
    await ingestVixInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('throws when EODHD returns zero rows', async () => {
    mockedFetch.mockResolvedValue([]);
    await expect(ingestVixInput(OBS_DATE, cfg)).rejects.toThrow();
  });

  it('[case 7] insufficient clean history (fewer than 5) → YELLOW + flag, never a silent short-window average', async () => {
    mockedFetch.mockResolvedValue(buildWeekdayRows([15, 16]));
    await ingestVixInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('YELLOW');
    expect(call.subChecks.insufficientHistory).toBe(true);
  });

  it('[case 1] forward-fills a single missing weekday (today missing from EODHD) — scores normally, NOT yellow', async () => {
    const full = buildWeekdayRows([15, 16, 17, 16.5, 16, 15.8]);
    const droppedToday = full.slice(0, -1);
    mockedFetch.mockResolvedValue(droppedToday);
    await ingestVixInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).not.toBe('YELLOW');
  });

  it('[case 3] stale beyond the 3-day market-data limit → YELLOW + stale flag', async () => {
    const full = buildWeekdayRows([15, 16, 17, 16.5, 16, 15.8, 15.5, 15.2]);
    const stale = full.slice(0, -4); // today + 3 prior weekdays all missing = 4 stale trading days > 3 limit
    mockedFetch.mockResolvedValue(stale);
    await ingestVixInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('YELLOW');
    expect(call.subChecks.stale).toBe(true);
  });
});

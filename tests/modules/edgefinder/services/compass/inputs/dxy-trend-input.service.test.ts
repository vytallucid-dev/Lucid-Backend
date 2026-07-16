import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/clients/eodhd/eodhd.client', () => ({
  eodhdClient: { fetchEodSeries: vi.fn() },
}));
vi.mock('@core/repositories/compass-inputs.repository', () => ({
  compassInputsRepository: { upsert: vi.fn() },
}));

import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { ingestDxyTrendInput } from '@modules/edgefinder/services/compass/inputs/dxy-trend-input.service';
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

describe('ingestDxyTrendInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('GREEN when calm (dev <= 2% and move5 <= 2%)', async () => {
    // 50 closes flat at 100 → dev = 0, move5 = 0
    mockedFetch.mockResolvedValue(buildWeekdayRows(new Array(50).fill(100)));
    await ingestDxyTrendInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('GREEN');
  });

  it('YELLOW when dev > 2% but move5 <= 3% (drifted from SMA but not a sharp break)', async () => {
    // SMA of last 50 ≈ 100.2; today's close is 102.5 → dev ≈ 2.3% (>2%); 5-obs-back
    // close is also 102.5 (flat over the last 5) → move5 = 0% (<=3%) → YELLOW
    const closes = [...new Array(45).fill(100), 102.5, 102.5, 102.5, 102.5, 102.5];
    mockedFetch.mockResolvedValue(buildWeekdayRows(closes));
    await ingestDxyTrendInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('YELLOW');
  });

  it('RED when 5-obs pct change > 3% regardless of dev', async () => {
    const closes = [...new Array(45).fill(100), 100, 101, 102, 103, 104, 105];
    mockedFetch.mockResolvedValue(buildWeekdayRows(closes));
    await ingestDxyTrendInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('throws when zero rows', async () => {
    mockedFetch.mockResolvedValue([]);
    await expect(ingestDxyTrendInput(OBS_DATE, cfg)).rejects.toThrow();
  });

  it('[case 7] insufficient clean history (fewer than 50) → YELLOW + flag, never a silent short-window SMA', async () => {
    mockedFetch.mockResolvedValue(buildWeekdayRows(new Array(30).fill(100)));
    await ingestDxyTrendInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('YELLOW');
    expect(call.subChecks.insufficientHistory).toBe(true);
  });

  it('[case 1] forward-fills a single missing weekday (today missing from EODHD) — scores normally, NOT yellow', async () => {
    const full = buildWeekdayRows(new Array(51).fill(100));
    const droppedToday = full.slice(0, -1);
    mockedFetch.mockResolvedValue(droppedToday);
    await ingestDxyTrendInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).not.toBe('YELLOW');
    expect(call.colorBand).toBe('GREEN');
  });

  it('[case 3] stale beyond the 3-day market-data limit → YELLOW + stale flag', async () => {
    const full = buildWeekdayRows(new Array(55).fill(100));
    const stale = full.slice(0, -4); // 4 missing trailing weekdays > 3-day limit
    mockedFetch.mockResolvedValue(stale);
    await ingestDxyTrendInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('YELLOW');
    expect(call.subChecks.stale).toBe(true);
  });
});

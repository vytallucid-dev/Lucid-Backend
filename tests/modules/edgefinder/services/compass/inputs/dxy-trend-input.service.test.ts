import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/clients/yahoo/yahoo.client', () => ({
  yahooClient: { fetchDailyHistory: vi.fn() },
}));
vi.mock('@core/repositories/compass-inputs.repository', () => ({
  compassInputsRepository: { upsert: vi.fn() },
}));

import { yahooClient } from '@core/clients/yahoo/yahoo.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { ingestDxyTrendInput } from '@modules/edgefinder/services/compass/inputs/dxy-trend-input.service';

const mockedFetch = yahooClient.fetchDailyHistory as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

function rows(closes: number[]) {
  return closes.map((c, i) => ({
    date: new Date(Date.UTC(2026, 1, i + 1)),
    open: c,
    high: c,
    low: c,
    close: c,
    adjClose: c,
    volume: 1000,
  }));
}

describe('ingestDxyTrendInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('YELLOW when range-bound (within 2% of SMA, low volatility)', async () => {
    // 50 closes around 100, last close also ~100 → distance ≈ 0, 5d change ≈ 0
    const closes = new Array(50).fill(100);
    mockedFetch.mockResolvedValue(rows(closes));
    await ingestDxyTrendInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('YELLOW');
  });

  it('GREEN when distance from SMA > 2%', async () => {
    // 50 closes at 100, then last close at 103 (extends history slightly)
    // The service uses the last 50 closes — let's give 55 so 50-SMA is mostly 100
    // and current close is 103.
    const closes = [
      ...new Array(49).fill(100),
      100, 100, 100, 100, 100, 103,
    ];
    mockedFetch.mockResolvedValue(rows(closes));
    await ingestDxyTrendInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('GREEN');
  });

  it('RED when 5-day pct change > 3%', async () => {
    // SMA stays near 100; last 5d ago was 100, last is 105 → 5d change +5%
    const closes = [
      ...new Array(45).fill(100),
      100, // 5d ago
      101,
      102,
      103,
      104,
      105, // today
    ];
    mockedFetch.mockResolvedValue(rows(closes));
    await ingestDxyTrendInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('throws when fewer than 50 closes', async () => {
    mockedFetch.mockResolvedValue(rows(new Array(30).fill(100)));
    await expect(
      ingestDxyTrendInput(new Date(Date.UTC(2026, 4, 18))),
    ).rejects.toThrow();
  });
});

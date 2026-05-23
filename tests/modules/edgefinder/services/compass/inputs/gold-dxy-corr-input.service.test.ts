import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/clients/yahoo/yahoo.client', () => ({
  yahooClient: { fetchDailyHistory: vi.fn() },
}));
vi.mock('@core/repositories/compass-inputs.repository', () => ({
  compassInputsRepository: { upsert: vi.fn() },
}));

import { yahooClient } from '@core/clients/yahoo/yahoo.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { ingestGoldDxyCorrInput } from '@modules/edgefinder/services/compass/inputs/gold-dxy-corr-input.service';

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

describe('ingestGoldDxyCorrInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('GREEN when gold and DXY are perfectly inversely correlated', async () => {
    const goldCloses = new Array(60).fill(0).map((_, i) => 2000 + i);
    const dxyCloses = new Array(60).fill(0).map((_, i) => 110 - i * 0.1);
    mockedFetch
      .mockResolvedValueOnce(rows(goldCloses))
      .mockResolvedValueOnce(rows(dxyCloses));

    await ingestGoldDxyCorrInput(new Date(Date.UTC(2026, 4, 18)));
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('GREEN');
    expect(call.rawValue).toBeCloseTo(-1, 5);
    expect(call.source).toBe('derived');
  });

  it('RED when gold and DXY are positively correlated', async () => {
    const goldCloses = new Array(60).fill(0).map((_, i) => 2000 + i);
    const dxyCloses = new Array(60).fill(0).map((_, i) => 100 + i * 0.1);
    mockedFetch
      .mockResolvedValueOnce(rows(goldCloses))
      .mockResolvedValueOnce(rows(dxyCloses));

    await ingestGoldDxyCorrInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('throws when aligned history is shorter than 60 trading days', async () => {
    const goldCloses = new Array(30).fill(2000);
    const dxyCloses = new Array(30).fill(100);
    mockedFetch
      .mockResolvedValueOnce(rows(goldCloses))
      .mockResolvedValueOnce(rows(dxyCloses));

    await expect(
      ingestGoldDxyCorrInput(new Date(Date.UTC(2026, 4, 18))),
    ).rejects.toThrow();
  });
});

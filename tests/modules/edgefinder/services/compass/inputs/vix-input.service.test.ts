import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/clients/yahoo/yahoo.client', () => ({
  yahooClient: { fetchDailyHistory: vi.fn() },
}));
vi.mock('@core/repositories/compass-inputs.repository', () => ({
  compassInputsRepository: { upsert: vi.fn() },
}));

import { yahooClient } from '@core/clients/yahoo/yahoo.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { ingestVixInput } from '@modules/edgefinder/services/compass/inputs/vix-input.service';

const mockedFetch = yahooClient.fetchDailyHistory as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

function row(date: string, close: number) {
  return {
    date: new Date(date),
    open: close,
    high: close,
    low: close,
    close,
    adjClose: close,
    volume: 1000,
  };
}

describe('ingestVixInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('upserts GREEN row when 5-day avg below 18', async () => {
    mockedFetch.mockResolvedValue([
      row('2026-05-12T00:00:00Z', 15),
      row('2026-05-13T00:00:00Z', 16),
      row('2026-05-14T00:00:00Z', 17),
      row('2026-05-15T00:00:00Z', 16.5),
      row('2026-05-18T00:00:00Z', 16),
    ]);

    await ingestVixInput(new Date(Date.UTC(2026, 4, 18)));

    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.inputCode).toBe('VIX_5D_AVG');
    expect(call.rawValue).toBe(16);
    expect(call.derivedValue).toBeCloseTo(16.1, 6);
    expect(call.colorBand).toBe('GREEN');
    expect(call.source).toBe('yahoo');
  });

  it('upserts RED row when 5-day avg above 25', async () => {
    mockedFetch.mockResolvedValue([
      row('2026-05-12T00:00:00Z', 28),
      row('2026-05-13T00:00:00Z', 29),
      row('2026-05-14T00:00:00Z', 30),
      row('2026-05-15T00:00:00Z', 31),
      row('2026-05-18T00:00:00Z', 32),
    ]);

    await ingestVixInput(new Date(Date.UTC(2026, 4, 18)));
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('RED');
  });

  it('throws when fewer than 5 closes returned', async () => {
    mockedFetch.mockResolvedValue([row('2026-05-12T00:00:00Z', 15)]);
    await expect(
      ingestVixInput(new Date(Date.UTC(2026, 4, 18))),
    ).rejects.toThrow();
  });

  it('throws when Yahoo returns zero rows', async () => {
    mockedFetch.mockResolvedValue([]);
    await expect(
      ingestVixInput(new Date(Date.UTC(2026, 4, 18))),
    ).rejects.toThrow();
  });
});

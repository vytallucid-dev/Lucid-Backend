import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/clients/fred/compass-fred.client', () => ({
  compassFredClient: {
    fetchSeries: vi.fn(),
    SERIES: {
      HY_OAS: 'BAMLH0A0HYM2',
      YIELD_2S10S: 'T10Y2Y',
      CPI: 'CPIAUCSL',
      GDP: 'GDP',
      NFP: 'PAYEMS',
      UNRATE: 'UNRATE',
    },
  },
}));
vi.mock('@core/repositories/compass-inputs.repository', () => ({
  compassInputsRepository: { upsert: vi.fn() },
}));

import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { ingestHyOasInput } from '@modules/edgefinder/services/compass/inputs/hy-oas-input.service';

const mockedFetch = compassFredClient.fetchSeries as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

function buildObs(values: (number | null)[]): { date: Date; value: number | null }[] {
  return values.map((v, i) => ({
    date: new Date(Date.UTC(2026, 3, i + 1)),
    value: v,
  }));
}

describe('ingestHyOasInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('GREEN: level <4.5 and tightening (30d change negative)', async () => {
    // 31 values; first=4.5, last=4.0 → change -0.5 → tightening; level < 4.5 → GREEN
    const values = new Array(31).fill(0).map((_, i) => 4.5 - i * 0.0166666);
    mockedFetch.mockResolvedValue(buildObs(values));

    await ingestHyOasInput(new Date(Date.UTC(2026, 4, 18)));
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.inputCode).toBe('HY_OAS');
    expect(call.colorBand).toBe('GREEN');
    expect(call.source).toBe('fred');
  });

  it('RED when level > 7.0', async () => {
    const values = new Array(31).fill(8.0);
    mockedFetch.mockResolvedValue(buildObs(values));
    await ingestHyOasInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('YELLOW when between thresholds', async () => {
    const values = new Array(31).fill(5.5);
    mockedFetch.mockResolvedValue(buildObs(values));
    await ingestHyOasInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('YELLOW');
  });

  it('throws when zero usable values', async () => {
    mockedFetch.mockResolvedValue(buildObs([null, null, null]));
    await expect(
      ingestHyOasInput(new Date(Date.UTC(2026, 4, 18))),
    ).rejects.toThrow();
  });
});

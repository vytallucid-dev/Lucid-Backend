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
import { ingestYieldCurveInput } from '@modules/edgefinder/services/compass/inputs/yield-curve-input.service';

const mockedFetch = compassFredClient.fetchSeries as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

function obs(values: number[]): { date: Date; value: number | null }[] {
  return values.map((v, i) => ({
    date: new Date(Date.UTC(2026, 3, i + 1)),
    value: v,
  }));
}

describe('ingestYieldCurveInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('GREEN when positive level + steepening', async () => {
    // 31 values: starts 0.10, ends 0.30 → level > 0, 30d change +0.20
    const values = new Array(31).fill(0).map((_, i) => 0.1 + i * 0.00666);
    mockedFetch.mockResolvedValue(obs(values));
    await ingestYieldCurveInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('GREEN');
  });

  it('RED when inverted + 30d change > 0.1 (re-steepening fast)', async () => {
    // 31 values: starts -0.5, ends -0.2 → level < 0, change +0.3
    const values = new Array(31).fill(0).map((_, i) => -0.5 + i * 0.01);
    mockedFetch.mockResolvedValue(obs(values));
    await ingestYieldCurveInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('YELLOW when inverted and stable', async () => {
    const values = new Array(31).fill(-0.3);
    mockedFetch.mockResolvedValue(obs(values));
    await ingestYieldCurveInput(new Date(Date.UTC(2026, 4, 18)));
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('YELLOW');
  });
});

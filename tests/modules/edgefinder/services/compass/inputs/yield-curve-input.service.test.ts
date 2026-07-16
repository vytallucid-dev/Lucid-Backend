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
vi.mock('@core/repositories/compass-curve-state.repository', () => ({
  compassCurveStateRepository: { upsert: vi.fn(), get: vi.fn() },
}));
vi.mock('@core/db/prisma', () => ({
  prisma: {
    compassInput: { findUnique: vi.fn() },
  },
}));

import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { compassCurveStateRepository } from '@core/repositories/compass-curve-state.repository';
import { prisma } from '@core/db/prisma';
import { ingestYieldCurveInput } from '@modules/edgefinder/services/compass/inputs/yield-curve-input.service';
import { COMPASS_CONFIG_V1_FIXTURE as cfg } from '../compass-config.fixture';

const mockedFetch = compassFredClient.fetchSeries as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedStateUpsert = compassCurveStateRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedFindUniqueInput = prisma.compassInput.findUnique as unknown as ReturnType<typeof vi.fn>;

const OBS_DATE = new Date(Date.UTC(2026, 4, 18));

// Dates count back from OBS_DATE so the series' LAST element always lands
// exactly on OBS_DATE — required for isWithinRedWindow's date-index lookup
// to find "today" in the scanned series (mirrors how the live code always
// fetches a series ending at/before the observation date).
function obs(values: number[]): { date: Date; value: number | null }[] {
  return values.map((v, i) => {
    const d = new Date(OBS_DATE);
    d.setUTCDate(d.getUTCDate() - (values.length - 1 - i));
    return { date: d, value: v };
  });
}

function mockJobsSubCheck(band: 'GREEN' | 'YELLOW' | 'RED'): void {
  mockedFindUniqueInput.mockResolvedValue({
    subChecks: { jobs: { band } },
  });
}

describe('ingestYieldCurveInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
    mockedStateUpsert.mockResolvedValue(undefined);
    mockJobsSubCheck('YELLOW');
  });

  it('GREEN when non-negative and delta30 >= floor, no episode in history', async () => {
    // Flat at 0.4 for the whole window — never inverted, delta30 = 0
    const values = new Array(100).fill(0.4);
    mockedFetch.mockResolvedValue(obs(values));
    await ingestYieldCurveInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.inputCode).toBe('YIELD_2S10S');
    expect(call.colorBand).toBe('GREEN');
    expect(call.source).toBe('fred');
  });

  it('YELLOW when negative but no confirmed episode (brief dip, not inside red window)', async () => {
    const values = [...new Array(90).fill(0.3), -0.1, -0.1]; // only 2-day dip, never confirms an episode
    mockedFetch.mockResolvedValue(obs(values));
    await ingestYieldCurveInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('YELLOW');
  });

  it('RED when inside the red window and jobs sub-check is not GREEN', async () => {
    // 10 inverted obs, then exactly 5 un-inverted obs ending at "today" (last element)
    const values = [
      ...new Array(50).fill(0.3),
      ...new Array(10).fill(-0.1),
      ...new Array(5).fill(0.1),
    ];
    mockedFetch.mockResolvedValue(obs(values));
    mockJobsSubCheck('RED');
    await ingestYieldCurveInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('GREEN overrides red window when jobs sub-check IS GREEN, if delta30/level also qualify', async () => {
    const values = [
      ...new Array(50).fill(0.3),
      ...new Array(10).fill(-0.1),
      ...new Array(5).fill(0.4), // un-inverted AND high enough for delta30 >= floor
    ];
    mockedFetch.mockResolvedValue(obs(values));
    mockJobsSubCheck('GREEN');
    await ingestYieldCurveInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('GREEN');
  });

  it('persists the scanned episode state via compassCurveStateRepository', async () => {
    const values = [
      ...new Array(50).fill(0.3),
      ...new Array(10).fill(-0.1),
      ...new Array(5).fill(0.1),
    ];
    mockedFetch.mockResolvedValue(obs(values));
    await ingestYieldCurveInput(OBS_DATE, cfg);
    expect(mockedStateUpsert).toHaveBeenCalledTimes(1);
    const stateArg = mockedStateUpsert.mock.calls[0][0];
    expect(stateArg.inversionStart).not.toBeNull();
    expect(stateArg.unInversionDate).not.toBeNull();
  });

  it('throws when US_DATA_STACK row is missing for the same date (jobs sub-check unresolvable)', async () => {
    const values = new Array(40).fill(0.3);
    mockedFetch.mockResolvedValue(obs(values));
    mockedFindUniqueInput.mockResolvedValue(null);
    await expect(ingestYieldCurveInput(OBS_DATE, cfg)).rejects.toThrow(/US_DATA_STACK/);
  });

  it('throws when jobs sub-check band is missing/invalid on the US_DATA_STACK row', async () => {
    const values = new Array(40).fill(0.3);
    mockedFetch.mockResolvedValue(obs(values));
    mockedFindUniqueInput.mockResolvedValue({ subChecks: { jobs: {} } });
    await expect(ingestYieldCurveInput(OBS_DATE, cfg)).rejects.toThrow(/jobs/i);
  });

  it('throws when FRED returns zero usable values', async () => {
    mockedFetch.mockResolvedValue([]);
    await expect(ingestYieldCurveInput(OBS_DATE, cfg)).rejects.toThrow();
  });
});

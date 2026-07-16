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
import { ingestUsDataStackInput } from '@modules/edgefinder/services/compass/inputs/us-data-stack-input.service';
import { COMPASS_CONFIG_V1_FIXTURE as cfg } from '../compass-config.fixture';

const mockedFetch = compassFredClient.fetchSeries as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

function obs(values: number[]) {
  return values.map((v, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)),
    value: v,
  }));
}

/**
 * Returns the mock setup so each fetchSeries call resolves to the right
 * series. compassFredClient.fetchSeries is called in this order:
 *   CPI, GDP, PAYEMS, UNRATE   (Promise.all preserves call order)
 */
function setupFetch(opts: {
  cpi: number[];
  gdp: number[];
  payems: number[];
  unrate: number[];
}) {
  mockedFetch.mockImplementation((seriesId: string) => {
    if (seriesId === 'CPIAUCSL') return Promise.resolve(obs(opts.cpi));
    if (seriesId === 'GDP') return Promise.resolve(obs(opts.gdp));
    if (seriesId === 'PAYEMS') return Promise.resolve(obs(opts.payems));
    if (seriesId === 'UNRATE') return Promise.resolve(obs(opts.unrate));
    return Promise.resolve([]);
  });
}

describe('ingestUsDataStackInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('aggregates two GREEN sub-bands to GREEN overall', async () => {
    // CPI: 15 months, last 3 YoY falling → GREEN
    // Build monthly CPI so YoY series ends on a strictly falling triplet:
    //   month i: level[i] = 100 + i  → YoY constant; we instead engineer dec.
    // Engineer: keep all but the last 3 levels at +1/month; last 3 levels: -2/month
    const cpi: number[] = [];
    for (let i = 0; i < 12; i++) cpi.push(100 + i); // months 0-11
    cpi.push(112);  // month 12 → YoY = 12.0
    cpi.push(110.5); // month 13 → YoY ≈ 9.4 (vs month 1 = 101)
    cpi.push(108); // month 14 → YoY ≈ 5.88 (vs month 2 = 102)
    // YoY last 3: 12.0, ~9.4, ~5.88 → falling

    // GDP: 3 quarters [100, 102, 103.5] → QoQ [2.0, 1.47] → mixed pos sub-1.5 → YELLOW
    // Tweak to GREEN: [100, 102, 104] → QoQ [2.0, 1.96] both > 1.5 → GREEN
    const gdp = [100, 102, 104];

    // Jobs: PAYEMS rising 200k/month, no Sahm trigger → GREEN
    const payems: number[] = [];
    for (let i = 0; i < 14; i++) payems.push(150000 + i * 200);

    // UNRATE: stable at 3.7 — no Sahm trigger
    const unrate = new Array(13).fill(3.7);

    setupFetch({ cpi, gdp, payems, unrate });

    await ingestUsDataStackInput(new Date(Date.UTC(2026, 4, 18)), cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.inputCode).toBe('US_DATA_STACK');
    expect(call.colorBand).toBe('GREEN');
    expect(call.source).toBe('fred');
    const sub = call.subChecks as { cpi: { band: string }; gdp: { band: string }; jobs: { band: string } };
    expect(sub.cpi.band).toBe('GREEN');
    expect(sub.gdp.band).toBe('GREEN');
    expect(sub.jobs.band).toBe('GREEN');
  });

  it('Sahm rule trigger drives jobs to RED regardless of NFP', async () => {
    const cpi: number[] = [];
    for (let i = 0; i < 15; i++) cpi.push(100);

    const gdp = [100, 101, 102]; // QoQ [1.0, 0.99] → YELLOW

    const payems: number[] = [];
    for (let i = 0; i < 14; i++) payems.push(150000 + i * 200); // healthy NFP

    // UNRATE: 12 months, last 3 avg = 4.3, 12-month low = 3.7 → delta 0.6 → Sahm triggered
    const unrate = [3.7, 3.8, 3.9, 4.0, 4.1, 4.2, 4.0, 3.9, 3.8, 4.3, 4.3, 4.3];

    setupFetch({ cpi, gdp, payems, unrate });

    await ingestUsDataStackInput(new Date(Date.UTC(2026, 4, 18)), cfg);
    const call = mockedUpsert.mock.calls[0][0];
    const sub = call.subChecks as {
      jobs: { band: string; sahm: { triggered: boolean } | null };
    };
    expect(sub.jobs.band).toBe('RED');
    expect(sub.jobs.sahm).not.toBeNull();
    expect(sub.jobs.sahm?.triggered).toBe(true);
  });

  it('aggregates 2 RED sub-bands to RED overall', async () => {
    // CPI rising → RED, GDP RED (negative), Jobs YELLOW
    const cpi: number[] = [];
    for (let i = 0; i < 12; i++) cpi.push(100);
    cpi.push(105, 107, 110);

    const gdp = [100, 98, 99];

    const payems: number[] = [];
    for (let i = 0; i < 14; i++) payems.push(150000 + i * 70); // ~70k/month → YELLOW

    const unrate = new Array(13).fill(3.7);

    setupFetch({ cpi, gdp, payems, unrate });

    await ingestUsDataStackInput(new Date(Date.UTC(2026, 4, 18)), cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });
});

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
import { COMPASS_CONFIG_V1_FIXTURE as cfg } from '../compass-config.fixture';

const mockedFetch = compassFredClient.fetchSeries as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassInputsRepository.upsert as unknown as ReturnType<typeof vi.fn>;

const OBS_DATE = new Date(Date.UTC(2026, 4, 18)); // Monday

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Build `count` observations on CONSECUTIVE WEEKDAYS (skipping Sat/Sun),
 * ending exactly on `endDate` — mirrors real FRED business-day publishing
 * (Phase 5: the reference calendar is weekday-filtered, so clean-data test
 * fixtures must also be weekday-only to stay "clean").
 */
function buildWeekdayObs(
  values: (number | null)[],
  endDate: Date = OBS_DATE,
): { date: Date; value: number | null }[] {
  const dates: Date[] = [];
  const cursor = new Date(endDate);
  while (dates.length < values.length) {
    if (!isWeekend(cursor)) dates.unshift(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.map((date, i) => ({ date, value: values[i] }));
}

describe('ingestHyOasInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpsert.mockResolvedValue({ id: 'ci-1', action: 'inserted' });
  });

  it('GREEN: calm level and calm 10-obs velocity', async () => {
    const values = new Array(31).fill(4.0);
    mockedFetch.mockResolvedValue(buildWeekdayObs(values));

    await ingestHyOasInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.inputCode).toBe('HY_OAS');
    expect(call.colorBand).toBe('GREEN');
    expect(call.source).toBe('fred');
  });

  it('RED when level > 5.50 regardless of velocity', async () => {
    const values = new Array(31).fill(6.0);
    mockedFetch.mockResolvedValue(buildWeekdayObs(values));
    await ingestHyOasInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('RED when 10-obs delta > 0.75 regardless of level', async () => {
    // last 11 values: flat at 4.0 except a jump of +0.8 in the final observation
    const values = [...new Array(20).fill(4.0), ...new Array(10).fill(4.0), 4.8];
    mockedFetch.mockResolvedValue(buildWeekdayObs(values));
    await ingestHyOasInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('RED');
  });

  it('YELLOW when level between 4.50 and 5.50 and velocity calm', async () => {
    const values = new Array(31).fill(5.0);
    mockedFetch.mockResolvedValue(buildWeekdayObs(values));
    await ingestHyOasInput(OBS_DATE, cfg);
    expect(mockedUpsert.mock.calls[0][0].colorBand).toBe('YELLOW');
  });

  it('throws when zero usable values', async () => {
    mockedFetch.mockResolvedValue(buildWeekdayObs([null, null, null]));
    await expect(ingestHyOasInput(OBS_DATE, cfg)).rejects.toThrow();
  });

  it('[case 1] forward-fills a single missing weekday (D missing, D-1 present) — scores normally, NOT yellow', async () => {
    // 31 weekday obs at 4.0, but drop the LAST one (today) from FRED's
    // response entirely — simulates FRED not having posted today's print yet.
    // 3-day stale limit comfortably covers a 1-day gap.
    const full = buildWeekdayObs(new Array(31).fill(4.0));
    const droppedToday = full.slice(0, -1); // today's real row is missing
    mockedFetch.mockResolvedValue(droppedToday);
    await ingestHyOasInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).not.toBe('YELLOW');
    expect(call.colorBand).toBe('GREEN');
  });

  it('[case 3] stale beyond the 5-day FRED limit → YELLOW + stale flag, weight still contributes', async () => {
    const full = buildWeekdayObs(new Array(31).fill(4.0));
    const stale = full.slice(0, -6); // today's + 5 prior weekdays all missing = 6 stale trading days
    mockedFetch.mockResolvedValue(stale);
    await ingestHyOasInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('YELLOW');
    expect(call.subChecks.stale).toBe(true);
  });

  it('[case 7] insufficient clean history for delta10 → YELLOW + flag, never a silent short-window compute', async () => {
    const values = new Array(5).fill(4.0); // far fewer than the 11 needed
    mockedFetch.mockResolvedValue(buildWeekdayObs(values));
    await ingestHyOasInput(OBS_DATE, cfg);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.colorBand).toBe('YELLOW');
    expect(call.subChecks.insufficientHistory).toBe(true);
  });
});

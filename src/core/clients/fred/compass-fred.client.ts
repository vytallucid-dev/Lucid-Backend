import { fredClient } from './fred.client';

const COMPASS_FRED_SERIES = {
  HY_OAS: 'BAMLH0A0HYM2',
  YIELD_2S10S: 'T10Y2Y',
  CPI: 'CPIAUCSL',
  GDP: 'GDP',
  NFP: 'PAYEMS',
  UNRATE: 'UNRATE',
} as const;

export type CompassFredSeriesId =
  (typeof COMPASS_FRED_SERIES)[keyof typeof COMPASS_FRED_SERIES];

export interface CompassFredObservation {
  date: Date;
  value: number | null;
}

function formatYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDateUtc(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export const compassFredClient = {
  SERIES: COMPASS_FRED_SERIES,

  /**
   * Fetch raw observations for a FRED series over the last `daysBack`
   * calendar days. Sorted ascending by date. Missing values (FRED's '.')
   * are mapped to null.
   */
  async fetchSeries(
    seriesId: CompassFredSeriesId,
    daysBack: number,
  ): Promise<CompassFredObservation[]> {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - daysBack);

    const result = await fredClient.getSeriesObservations({
      seriesId,
      observationStart: formatYmd(start),
      observationEnd: formatYmd(end),
    });

    const mapped: CompassFredObservation[] = result.observations.map((o) => ({
      date: parseDateUtc(o.date),
      value: o.value === '.' || o.value === '' ? null : Number(o.value),
    }));

    mapped.sort((a, b) => a.date.getTime() - b.date.getTime());
    return mapped;
  },

  /**
   * Fetch raw observations for a FRED series between two specific dates
   * (inclusive). Used by historical backfill so the lookback window can be
   * anchored at any past date. Missing values (FRED's '.') are mapped to
   * null.
   */
  async fetchSeriesByDateRange(
    seriesId: CompassFredSeriesId,
    startDate: Date,
    endDate: Date,
  ): Promise<CompassFredObservation[]> {
    const result = await fredClient.getSeriesObservations({
      seriesId,
      observationStart: formatYmd(startDate),
      observationEnd: formatYmd(endDate),
    });

    const mapped: CompassFredObservation[] = result.observations.map((o) => ({
      date: parseDateUtc(o.date),
      value: o.value === '.' || o.value === '' ? null : Number(o.value),
    }));

    mapped.sort((a, b) => a.date.getTime() - b.date.getTime());
    return mapped;
  },
};

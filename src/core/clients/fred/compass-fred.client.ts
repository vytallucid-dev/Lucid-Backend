import { fredClient } from './fred.client';

const COMPASS_FRED_SERIES = {
  HY_OAS: 'BAMLH0A0HYM2',
  YIELD_2S10S: 'T10Y2Y',
  CPI: 'CPIAUCSL',
  GDP: 'GDP',
  NFP: 'PAYEMS',
  UNRATE: 'UNRATE',
  // Phase 6 (Addendum 8A): raw 2-year Treasury daily yield. Compass-local
  // plumbing for the rate gate — NOT a voting input. The EdgeFinder
  // US_02Y_SMA indicator stores only the already-computed 21d SMA in
  // data_points, discarding the raw daily close; the rate gate needs the raw
  // close AND its own 21-obs SMA, so Compass fetches DGS2 itself.
  US_02Y: 'DGS2',

  // ---- Phase C additions -------------------------------------------------
  /**
   * R1_REAL_YIELD_SHOCK — 10-year TIPS real yield. The one new rule Phase B's
   * evidence supports: the 60-day change explains gold at R^2 0.21 in-sample
   * AND 0.21 out-of-sample, with a monotone sensitivity curve across the whole
   * 0-110bp threshold range. Ships NON-VOTING in this phase.
   * Available from 2003-01-02 — which is also the hard limit on how far back
   * the curve GREEN gate can be evaluated.
   */
  REAL_YIELD_10Y: 'DFII10',
  /**
   * Long-history credit. FRED has retroactively truncated EVERY ICE BofA OAS
   * series (including HY_OAS above) to 2023-09-11+, across all vintages, so
   * HY_OAS cannot describe any historical episode and Trigger A is
   * structurally unable to fire before that date. BAA10Y is Moody's, not
   * ICE-licensed, and runs daily from 1986.
   */
  BAA_SPREAD: 'BAA10Y',
  /** Long-end display readings. */
  US_30Y: 'DGS30',
  US_20Y: 'DGS20',
  US_10Y: 'DGS10',
  /** 10-year breakeven inflation, for the real-yield/breakeven decomposition. */
  BREAKEVEN_10Y: 'T10YIE',
  /**
   * Kim-Wright 10-year term premium. Shown ALONGSIDE the NY Fed's ACM measure,
   * never instead of it: the two disagree on the term-premium share of the 2013
   * taper tantrum by 0.36, on April 2025 by 1.22, and on the sign of the
   * current 2026 regime. Displaying either alone would present one model's
   * opinion as fact.
   */
  TERM_PREMIUM_KW: 'THREEFYTP10',
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
   *
   * Phase C: `asOfDate` requests the ALFRED VINTAGE as of that date — the data
   * exactly as it was known then, rather than as later revised. Pass it for any
   * historical/validation work on a REVISED series (CPIAUCSL, GDP, PAYEMS,
   * UNRATE). Omit it for daily market and rate series, which are not revised,
   * and for the live path.
   *
   * Without it, a backfill of 2008 sees both today's revised figures AND
   * observations that were not published until weeks after the date being
   * scored. Measured effect on the 2008 window: 28.0% Risk-Off point-in-time
   * versus 60.6% latest-vintage — the single largest bias found in Phase B.
   */
  async fetchSeriesByDateRange(
    seriesId: CompassFredSeriesId,
    startDate: Date,
    endDate: Date,
    asOfDate?: Date,
  ): Promise<CompassFredObservation[]> {
    const realtime = asOfDate ? formatYmd(asOfDate) : undefined;
    const result = await fredClient.getSeriesObservations({
      seriesId,
      observationStart: formatYmd(startDate),
      observationEnd: formatYmd(endDate),
      ...(realtime ? { realtimeStart: realtime, realtimeEnd: realtime } : {}),
    });

    const mapped: CompassFredObservation[] = result.observations.map((o) => ({
      date: parseDateUtc(o.date),
      value: o.value === '.' || o.value === '' ? null : Number(o.value),
    }));

    mapped.sort((a, b) => a.date.getTime() - b.date.getTime());
    return mapped;
  },
};

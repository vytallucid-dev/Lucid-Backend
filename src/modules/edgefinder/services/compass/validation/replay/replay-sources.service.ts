import { fredClient } from '@core/clients/fred/fred.client';
import { yahooClient } from '@core/clients/yahoo/yahoo.client';
import { logger } from '@core/utils/logger';
import type { DatedValue } from './series';
import type { ReplaySources } from './engine';

/**
 * Data layer for the historical replay.
 *
 * WHY NOT THE LIVE INPUT SERVICES
 * -------------------------------
 * The live path reads VIX, VIX3M, DXY and USDJPY from EODHD, which cannot serve
 * this purpose for two independent reasons:
 *
 *   1. The account returns TWELVE MONTHS of history. Of the eight validation
 *      windows, only the June 2026 one falls inside that.
 *   2. The client enforces a 15-call/day cap that is PROCESS-GLOBAL and shared
 *      with NIFTY. Compass already spends ~5/day and NIFTY 2. A day-by-day
 *      backfill of 2008 would need hundreds of calls against that budget.
 *
 * So the replay substitutes FRED and Yahoo. Phase B measured the substitution
 * error directly against a 12-month EODHD overlap, and it is immaterial:
 *
 *   VIX    <- FRED VIXCLS   mean abs diff 0.057%; the 5-day-average BAND
 *                           differs on 0.0% of days
 *   VIX3M  <- FRED VXVCLS   identical series (correlation 1.000000)
 *   DXY    <- Yahoo DX-Y.NYB mean abs diff 0.015%, max 0.225%; `dev` crosses
 *                           the 0.02 threshold differently on 0.5% of days
 *   USDJPY <- FRED DEXJPUS  mean abs diff 0.119% (a different fixing time —
 *                           NY noon vs close); Shock-Layer plumbing only
 *
 * This substitution MUST be reported wherever validation results are surfaced,
 * not just recorded here — see SOURCE_SUBSTITUTIONS below, which is persisted
 * into every validation report.
 *
 * COST: one request per series for full history — about eight — plus four for
 * the ALFRED vintage tables, for an entire eight-window run.
 */

/** Machine-readable provenance, persisted with every validation report. */
export const SOURCE_SUBSTITUTIONS = [
  {
    input: 'VIX_5D_AVG',
    liveSource: 'EODHD VIX.INDX',
    replaySource: 'FRED VIXCLS',
    measuredError: 'mean abs diff 0.057%, max 14.7% on one day',
    bandImpact: '5-day-average band differs on 0.0% of overlapping days',
  },
  {
    input: 'VIX_TERM_STRUCTURE',
    liveSource: 'EODHD VIX3M.INDX',
    replaySource: 'FRED VXVCLS',
    measuredError: '0.000%',
    bandImpact: 'identical series (correlation 1.000000)',
  },
  {
    input: 'DXY_TREND',
    liveSource: 'EODHD DXY.INDX',
    replaySource: 'Yahoo DX-Y.NYB',
    measuredError: 'mean abs diff 0.015%, max 0.225%',
    bandImpact: 'dev crosses the 0.02 threshold differently on 0.5% of overlapping days',
  },
  {
    input: 'USDJPY_PRICE',
    liveSource: 'EODHD USDJPY.FOREX',
    replaySource: 'FRED DEXJPUS',
    measuredError: 'mean abs diff 0.119%, max 1.211% (NY noon fixing vs close)',
    bandImpact: 'Shock Layer plumbing only; carries no band and no vote',
  },
] as const;

/**
 * Why the whole exercise is bracketed rather than asserted before 2023-09-11.
 */
export const HY_OAS_LIMITATION =
  'FRED has retroactively truncated every ICE BofA OAS series, across all vintages, to ' +
  '2023-09-11 onward. HY_OAS carries weight 1.5 of 8.0 AND is one of Trigger A\'s two legs, ' +
  'so before that date the credit vote is uncomputable and Trigger A is structurally unable ' +
  'to fire. Pre-2023 windows are therefore reported as a BRACKET (absent / proxy / forced-red), ' +
  'not as a measurement.';

/** BAA10Y -> HY OAS proxy fitted on the 745-day overlap (R^2 = 0.271). */
const HYOAS_PROXY_INTERCEPT = 0.7285;
const HYOAS_PROXY_SLOPE = 0.818;

export const HY_OAS_PROXY_LIMITATION =
  `ln(HYOAS) = ${HYOAS_PROXY_INTERCEPT} + ${HYOAS_PROXY_SLOPE}*ln(BAA10Y), R^2 = 0.271, fitted on a ` +
  'three-year CALM overlap (BAA10Y 1.36-2.02) and extrapolated ~3x into 2008\'s 6.11. The log ' +
  'slope below 1 means it COMPRESSES: it puts the Dec 2008 peak at 9.11 and Mar 2020 at 6.85, ' +
  'both materially below what the index actually reached. It is a conservative LOWER BOUND on ' +
  'credit stress, not an estimate.';

function parseUtc(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function fredSeries(seriesId: string, observationStart = '1960-01-01'): Promise<DatedValue[]> {
  const result = await fredClient.getSeriesObservations({ seriesId, observationStart });
  const out: DatedValue[] = [];
  for (const o of result.observations) {
    if (o.value === '.' || o.value === '') continue;
    const value = Number(o.value);
    if (!Number.isFinite(value)) continue;
    out.push({ date: parseUtc(o.date), value });
  }
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

async function yahooSeries(symbol: string, fromYear: number): Promise<DatedValue[]> {
  const daysBack = Math.ceil((Date.now() - Date.UTC(fromYear, 0, 1)) / 86_400_000);
  const rows = await yahooClient.fetchDailyHistory({ symbol, daysBack });
  return rows
    .filter((r) => Number.isFinite(r.close))
    .map((r) => ({ date: parseUtc(r.date), value: r.close }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Apply the fitted proxy to a BAA10Y series. */
export function hyOasProxyFromBaa(baa: DatedValue[]): DatedValue[] {
  return baa
    .filter((o) => o.value > 0)
    .map((o) => ({
      date: o.date,
      value: Math.exp(HYOAS_PROXY_INTERCEPT + HYOAS_PROXY_SLOPE * Math.log(o.value)),
    }));
}

/**
 * Splice: the real index where it exists, the proxy before it. Used for the
 * `proxy` bracket only — never for the primary reported figure.
 */
export function spliceHyOas(real: DatedValue[], proxy: DatedValue[]): DatedValue[] {
  if (real.length === 0) return proxy;
  const firstReal = real[0].date.getTime();
  return [...proxy.filter((o) => o.date.getTime() < firstReal), ...real].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
}

export interface LoadedReplaySources extends ReplaySources {
  /** Real BAMLH0A0HYM2, 2023-09-11 onward only. */
  hyOasReal: DatedValue[];
  /** BAA10Y-derived proxy spliced before the real index begins. */
  hyOasProxy: DatedValue[];
  /** Long-history Moody's credit spread, for the Volatility & Credit module. */
  baa10y: DatedValue[];
}

let cached: LoadedReplaySources | null = null;

/**
 * Fetch every series the replay engine needs, once per process.
 *
 * Sequential rather than parallel: FRED's public CDN returns 403 under bursty
 * traffic, and the shared client's retry policy already backs off 5s/15s/45s/90s
 * on that status. Eight sequential requests is a few seconds; eight parallel
 * ones risk a throttle that costs minutes.
 */
export async function loadReplaySources(force = false): Promise<LoadedReplaySources> {
  if (cached && !force) return cached;

  const vix = await fredSeries('VIXCLS', '1990-01-01');
  const vix3m = await fredSeries('VXVCLS', '2007-01-01');
  const hyOasReal = await fredSeries('BAMLH0A0HYM2', '1996-01-01');
  const t10y2y = await fredSeries('T10Y2Y', '1976-01-01');
  const dgs2 = await fredSeries('DGS2', '1976-01-01');
  const usdJpy = await fredSeries('DEXJPUS', '1971-01-01');
  const dfii10 = await fredSeries('DFII10', '2003-01-01');
  const baa10y = await fredSeries('BAA10Y', '1986-01-01');
  const dxy = await yahooSeries('DX-Y.NYB', 1990);

  const hyOasProxy = spliceHyOas(hyOasReal, hyOasProxyFromBaa(baa10y));

  cached = {
    vix,
    vix3m,
    dxy,
    hyOas: hyOasReal,
    hyOasReal,
    hyOasProxy,
    baa10y,
    t10y2y,
    dgs2,
    usdJpy,
    dfii10,
  };

  const span = (s: DatedValue[]): string =>
    s.length === 0
      ? 'EMPTY'
      : `${s.length} obs ${s[0].date.toISOString().slice(0, 10)}..${s.at(-1)!.date.toISOString().slice(0, 10)}`;

  logger.info(
    {
      vix: span(vix),
      vix3m: span(vix3m),
      dxy: span(dxy),
      hyOasReal: span(hyOasReal),
      baa10y: span(baa10y),
      t10y2y: span(t10y2y),
      dgs2: span(dgs2),
      usdJpy: span(usdJpy),
      dfii10: span(dfii10),
    },
    'Replay: source series loaded',
  );

  return cached;
}

export function __clearReplaySourceCache(): void {
  cached = null;
}

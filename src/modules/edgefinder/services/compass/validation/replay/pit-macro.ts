/**
 * Point-in-time macro for the replay — production port of
 * the Phase B research harness, archived outside this
 * repo in Lucid-Research/research/phase-b/replay/pit-macro.ts.
 *
 * WHY THIS EXISTS
 * ---------------
 * `us-data-stack-input.service.ts` historically requested CPI/GDP/PAYEMS/UNRATE
 * with `observation_end` only. That bounds which observation DATES come back; it
 * does not bound what was KNOWN on the date being scored. Two biases follow:
 *
 *   1. REVISION bias — FRED serves the latest revised value, not the first print.
 *      PAYEMS for June 2008 reads 137,700 today and was 137,666 as known then.
 *   2. PUBLICATION-LAG bias, the larger — an observation dated 2008-09-01 was not
 *      released until mid-October 2008, yet a filter of `obs.date <= 2008-09-02`
 *      admits it six weeks early. Verified live: an unbounded request as of
 *      2008-09-02 returns an observation dated 2008-09-01; the point-in-time
 *      request correctly stops at 2008-07-01, two whole months earlier.
 *
 * Replaying 2008 with the latest vintage gives 60.6% Risk-Off — a pass. Replaying
 * it point-in-time gives 28.0% — a fail. Any historical result produced without
 * this looks roughly twice as good as the truth.
 *
 * HOW
 * ---
 * ALFRED returns the FULL vintage table for a series in ONE request when asked
 * for `realtime_start=1776-07-04` / `realtime_end=9999-12-31`: every
 * (observation date, realtime interval, value) triple. That is loaded once per
 * series and filtered in memory, so an entire multi-window replay costs four
 * requests rather than one per series per date.
 */
import { fredClient } from '@core/clients/fred/fred.client';
import { logger } from '@core/utils/logger';

/** The four revised series the Data Stack reads. */
export const VINTAGED_SERIES = ['CPIAUCSL', 'GDP', 'PAYEMS', 'UNRATE'] as const;
export type VintagedSeriesId = (typeof VINTAGED_SERIES)[number];

interface VintageRow {
  obsDate: number; // epoch ms
  rtStart: number;
  rtEnd: number;
  value: number;
}

/** The ALFRED idiom for "every vintage of every observation, as one table". */
const ALFRED_ALL_VINTAGES_START = '1776-07-04';
const ALFRED_ALL_VINTAGES_END = '9999-12-31';

const cache = new Map<string, VintageRow[]>();

function parseUtcMs(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Load (once) the complete vintage table for a series. Must be awaited for every
 * series before any of the synchronous lookups below are used.
 */
export async function loadVintages(seriesId: VintagedSeriesId): Promise<void> {
  if (cache.has(seriesId)) return;

  const result = await fredClient.getSeriesObservations({
    seriesId,
    observationStart: '1940-01-01',
    realtimeStart: ALFRED_ALL_VINTAGES_START,
    realtimeEnd: ALFRED_ALL_VINTAGES_END,
  });

  const rows: VintageRow[] = [];
  for (const o of result.observations) {
    if (o.value === '.' || o.value === '') continue;
    const value = Number(o.value);
    if (!Number.isFinite(value)) continue;
    rows.push({
      obsDate: parseUtcMs(o.date),
      rtStart: parseUtcMs(o.realtime_start),
      rtEnd: parseUtcMs(o.realtime_end),
      value,
    });
  }
  rows.sort((a, b) => a.obsDate - b.obsDate || a.rtStart - b.rtStart);
  cache.set(seriesId, rows);

  logger.info(
    { seriesId, vintageRows: rows.length, distinctObs: new Set(rows.map((r) => r.obsDate)).size },
    'Replay: ALFRED vintage table loaded',
  );
}

export async function loadAllVintages(): Promise<void> {
  for (const s of VINTAGED_SERIES) await loadVintages(s);
}

function rowsFor(seriesId: string): VintageRow[] {
  const rows = cache.get(seriesId);
  if (!rows) {
    throw new Error(
      `Replay: vintage table for ${seriesId} not loaded — call loadAllVintages() first`,
    );
  }
  return rows;
}

/**
 * The series as it was actually known on `asOf`: one value per observation date,
 * taking the vintage whose realtime interval spans `asOf`. Observations not yet
 * published as of `asOf` are simply absent, exactly as they were.
 */
export function asOfLevels(seriesId: string, asOf: Date): number[] {
  const t = asOf.getTime();
  const byObs = new Map<number, number>();
  for (const r of rowsFor(seriesId)) {
    if (r.rtStart <= t && t <= r.rtEnd) byObs.set(r.obsDate, r.value);
  }
  return [...byObs.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

/**
 * Latest-vintage levels with obs_date <= asOf — i.e. what the live code path
 * sees. Retained so the look-ahead bias can be MEASURED rather than asserted.
 */
export function latestVintageLevels(seriesId: string, asOf: Date): number[] {
  const t = asOf.getTime();
  const byObs = new Map<number, { rt: number; v: number }>();
  for (const r of rowsFor(seriesId)) {
    if (r.obsDate > t) continue;
    const cur = byObs.get(r.obsDate);
    if (!cur || r.rtStart > cur.rt) byObs.set(r.obsDate, { rt: r.rtStart, v: r.value });
  }
  return [...byObs.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1].v);
}

/** Earliest realtime date on record — the limit of point-in-time correctness. */
export function earliestVintage(seriesId: string): Date {
  const rows = rowsFor(seriesId);
  return new Date(Math.min(...rows.map((r) => r.rtStart)));
}

/** For reporting: how many observations the live path sees that PIT does not. */
export function lookaheadDiagnostic(
  seriesId: string,
  asOf: Date,
): { pit: number; latest: number; extraObservations: number } {
  const pit = asOfLevels(seriesId, asOf).length;
  const latest = latestVintageLevels(seriesId, asOf).length;
  return { pit, latest, extraObservations: latest - pit };
}

/** Test seam: inject a vintage table without hitting FRED. */
export function __setVintagesForTest(
  seriesId: string,
  rows: Array<{ obsDate: string; realtimeStart: string; realtimeEnd: string; value: number }>,
): void {
  cache.set(
    seriesId,
    rows
      .map((r) => ({
        obsDate: parseUtcMs(r.obsDate),
        rtStart: parseUtcMs(r.realtimeStart),
        rtEnd: parseUtcMs(r.realtimeEnd),
        value: r.value,
      }))
      .sort((a, b) => a.obsDate - b.obsDate || a.rtStart - b.rtStart),
  );
}

export function __clearVintageCache(): void {
  cache.clear();
}

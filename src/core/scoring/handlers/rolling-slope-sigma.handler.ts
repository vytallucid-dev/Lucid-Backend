import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { ScoringContext, ScoringResult, Score } from '../types';
import { getSkipDates } from '../helpers/frozen-date-crosscheck';

interface Band {
  min: number | null;
  max: number | null;
  score: Score;
}

interface SlopeSigmaRule {
  window_size: number; // 10 — number of observations the OLS fit uses
  sigma_lookback_max: number; // 250
  sigma_lookback_min: number; // 60 — below this, insufficient_data
  bands: Band[]; // thresholds expressed in sigma multiples
}

/**
 * OLS slope of price over an observation-indexed window (x = 0..n-1,
 * chronological — oldest first), expressed as a percentage of the window's
 * mean price:
 *   slope   = Σ((xᵢ−x̄)(pᵢ−p̄)) / Σ((xᵢ−x̄)²)
 *   measure = (slope × 10) / mean(p) × 100
 */
function olsSlopeMeasure(pricesChronological: number[]): number {
  const n = pricesChronological.length;
  const xbar = (n - 1) / 2;
  const pbar = pricesChronological.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xbar;
    num += dx * (pricesChronological[i] - pbar);
    den += dx * dx;
  }
  const slope = num / den;
  return ((slope * 10) / pbar) * 100;
  // pbar === 0 (or any degenerate window) yields Infinity/NaN here. Not
  // special-cased explicitly — DXY/Brent/USDINR prices cannot realistically
  // reach zero, and a NaN/Infinity measure is caught downstream anyway: it
  // poisons sigma (sample stdev of a series containing NaN is NaN) which the
  // `!(sigma > 0)` guard rejects, and for today's own measure a NaN/Infinity
  // measureInSigma matches no band and falls through to insufficient_data.
}

function sampleStdDev(values: number[]): number {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1); // Bessel-corrected (n-1)
  return Math.sqrt(variance);
}

/**
 * Sigma-scaled OLS-slope scoring. Introduced 2026-08-17 for Ind 10 (DXY),
 * Ind 11 (Brent), Ind 12 (USD/INR) — v3 rule, replaces the endpoint-delta
 * rolling_pct_direction / rolling_pct_tiered rules for these three. Not
 * shared with any other indicator.
 *
 * Deliberately does NOT call helpers/rolling-window.ts's selectRollingWindow:
 * that helper returns one fixed-size window (used by the two endpoint-delta
 * handlers, which remain in place — historical scores under their v2 rule
 * must stay reproducible). This handler needs a full SLIDING series of
 * slope measures, one per historical trading day, to compute its own
 * trailing standard deviation — a materially different query shape, not a
 * second copy of the same single-window logic.
 *
 * Known limitation (documented, not a bug): Ind 10 (DXY) only has ~82
 * distinct dated observations as of this rule's introduction (ingestion
 * started 2026-04-23), so its sigma is estimated from as few as ~73 slope
 * observations rather than the 250-observation target — it won't reach 250
 * until roughly April 2027 at daily cadence. This is accepted per instruction:
 * sigma is a volatility estimate, not a signal estimate, and is reasonably
 * stable at n≈75; the fixed-threshold rule it replaces was calibrated on no
 * data at all. No compensating logic — DXY runs the identical algorithm as
 * Brent/USD/INR, just against a shorter available history.
 */
export async function rollingSlopeSigmaHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as unknown as SlopeSigmaRule;
  const WINDOW = rule.window_size;
  const SIGMA_MAX = rule.sigma_lookback_max;
  const SIGMA_MIN = rule.sigma_lookback_min;

  // Need enough raw distinct-date points to produce up to SIGMA_MAX slope
  // measures, each consuming its own WINDOW-point sub-window, sliding by 1.
  const maxRawNeeded = SIGMA_MAX + WINDOW - 1;

  const { skipDates, warnings } = await getSkipDates({
    indicatorCode: ctx.indicatorCode,
    indicatorId: ctx.indicatorId,
    observationDate: ctx.observationDate,
    lookbackRows: maxRawNeeded,
  });
  for (const warning of warnings) {
    logger.warn(warning, 'Suspected frozen feed breakage detected during rolling window scan');
  }

  const supersetTake =
    skipDates.size > 0 ? maxRawNeeded + skipDates.size + 20 : maxRawNeeded + 20;

  const superset = await prisma.dataPoint.findMany({
    where: {
      indicatorId: ctx.indicatorId,
      isCurrent: true,
      observationDate: { lte: ctx.observationDate },
    },
    orderBy: [{ observationDate: 'desc' }, { vintageDate: 'desc' }],
    take: supersetTake,
  });

  // Collapse duplicate observation dates to the latest vintage (defensive —
  // same convention as handlers/percentile-rank.handler.ts; not currently
  // observed for Ind 10/11/12 but cheap to guard), and drop frozen/
  // suspected-stale dates (see A2 recon: Brent has 10 weekend rows that are
  // exact-duplicate carries of the prior close — this is what excludes them).
  const byDate = new Map<string, { value: number; observationDate: Date }>();
  for (const row of superset) {
    const key = row.observationDate.toISOString().slice(0, 10);
    if (skipDates.has(key)) continue;
    if (!byDate.has(key)) {
      byDate.set(key, { value: Number(row.value), observationDate: row.observationDate });
    }
  }
  // `superset` is ordered newest-first, so Map insertion order (and thus
  // Array.from(...values())) is also newest-first.
  const desc = Array.from(byDate.values());
  const asc = desc.slice(0, maxRawNeeded).reverse(); // oldest..newest, chronological

  if (asc.length < WINDOW) {
    return {
      kind: 'insufficient_data',
      reason: `Need ${WINDOW} points for slope window; have ${asc.length}`,
    };
  }

  // Slide a WINDOW-sized OLS fit across every position the data supports —
  // one slope measure per historical trading day. The last entry is today's.
  // Never reads past `ctx.observationDate` (asc is bounded by the `lte`
  // query above), so this never uses future data.
  const slopeSeries: { date: string; measure: number }[] = [];
  for (let end = WINDOW - 1; end < asc.length; end++) {
    const windowPoints = asc.slice(end - WINDOW + 1, end + 1);
    const measure = olsSlopeMeasure(windowPoints.map((p) => p.value));
    slopeSeries.push({ date: asc[end].observationDate.toISOString().slice(0, 10), measure });
  }

  const today = slopeSeries[slopeSeries.length - 1];

  // Sigma population: trailing up to SIGMA_MAX slope measures, up to and
  // including today's own (slopeSeries is strictly chronological and never
  // extends past observationDate).
  const sigmaPopulation = slopeSeries.slice(Math.max(0, slopeSeries.length - SIGMA_MAX));
  const sigmaObservationCount = sigmaPopulation.length;

  if (sigmaObservationCount < SIGMA_MIN) {
    return {
      kind: 'insufficient_data',
      reason: `Need ${SIGMA_MIN} slope-measure observations for sigma; have ${sigmaObservationCount}`,
    };
  }

  const sigma = sampleStdDev(sigmaPopulation.map((s) => s.measure));
  if (!(sigma > 0)) {
    return {
      kind: 'insufficient_data',
      reason: 'Sigma is zero or undefined over the trailing window',
    };
  }

  const measureInSigma = today.measure / sigma;

  let score: Score | null = null;
  for (const band of rule.bands) {
    const aboveMin = band.min === null || measureInSigma >= band.min;
    const belowMax = band.max === null || measureInSigma < band.max;
    if (aboveMin && belowMax) {
      score = band.score;
      break;
    }
  }
  if (score === null) {
    return { kind: 'insufficient_data', reason: `sigma-scaled measure ${measureInSigma} matched no band` };
  }

  return {
    kind: 'scored',
    score,
    flags: [],
    metadata: {
      measure: today.measure,
      sigma,
      measureInSigma,
      sigmaObservationCount,
      windowSize: WINDOW,
      newestObservationDate: asc[asc.length - 1].observationDate.toISOString().slice(0, 10),
      oldestObservationDate: asc[asc.length - WINDOW].observationDate.toISOString().slice(0, 10),
    },
  };
}

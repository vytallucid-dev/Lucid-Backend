import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { mofClient } from '@core/clients/mof/mof.client';
import { bundesbankClient } from '@core/clients/bundesbank/bundesbank.client';
import { bisClient } from '@core/clients/bis/bis.client';
import { generateTradingDays } from '@core/utils/us-market-calendar';
import { buildCleanSeries, obsChangeFromClean, type DatedValue } from '../compass-staleness';
import type { ColorBand } from '../compass-bands';
import type { CompassConfigDefinition } from '../compass-config.types';
import { explanation } from './templates';
import { BOE_STALE_LIMIT_DAYS, manualPolicyRateSeries } from './admin-policy-rate.source';
import type { ModuleCode, ModuleReading, StalenessState } from './module-types';

/**
 * Builds every layer-1 reading for a date.
 *
 * Two sources feed it:
 *   - the six voting `compass_inputs` rows plus R1 (already computed by the
 *     classifier path, so the vote a module reports is EXACTLY the vote the
 *     classifier used — the module layer never re-derives a band);
 *   - display-only series fetched here (long-end yields, breakevens, both term
 *     premium models, cross-country curves, policy rates).
 *
 * STALENESS IS FIRST CLASS. Every reading carries its source, the as-of date of
 * the underlying observation, and whether that observation was fresh, filled,
 * stale or missing. Nothing is silently forward-filled onto the page.
 */

const VOTING_WEIGHT_FALLBACK = 0;

interface SeriesFetch {
  code: string;
  values: DatedValue[];
}

function toDated(obs: Array<{ date: Date; value: number | null }>): DatedValue[] {
  return obs
    .filter((o): o is { date: Date; value: number } => o.value !== null)
    .map((o) => ({ date: o.date, value: o.value }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Latest observation at or before asOf, with its staleness. */
function latest(
  series: DatedValue[],
  asOf: Date,
  staleLimitTradingDays: number,
): { value: number | null; asOfDate: Date | null; state: StalenessState; days: number | null } {
  const upto = series.filter((o) => o.date.getTime() <= asOf.getTime());
  if (upto.length === 0) {
    return { value: null, asOfDate: null, state: 'MISSING', days: null };
  }
  const last = upto[upto.length - 1];
  const calendar = generateTradingDays(last.date, asOf);
  // calendar includes both endpoints when both are trading days.
  const gap = Math.max(0, calendar.length - 1);
  const state: StalenessState =
    gap === 0 ? 'FRESH' : gap > staleLimitTradingDays ? 'STALE' : 'FILLED';
  return { value: last.value, asOfDate: last.date, state, days: gap };
}

function makeReading(
  partial: Omit<ModuleReading, 'isVoting' | 'weight' | 'colorBand' | 'stateLabel'> &
    Partial<Pick<ModuleReading, 'isVoting' | 'weight' | 'colorBand' | 'stateLabel'>>,
): ModuleReading {
  return {
    colorBand: null,
    isVoting: false,
    weight: null,
    stateLabel: null,
    ...partial,
  };
}

// ---------------------------------------------------------------- input map
/** Which module each voting input belongs to, and its display title. */
const VOTING_INPUTS: Record<
  string,
  { module: ModuleCode; readingCode: string; title: string; source: string }
> = {
  VIX_5D_AVG: { module: 'VOL_CREDIT', readingCode: 'VIX_5D_AVG', title: 'VIX, 5-day average', source: 'EODHD:VIX.INDX' },
  VIX_TERM_STRUCTURE: { module: 'VOL_CREDIT', readingCode: 'VIX_TERM_STRUCTURE', title: 'VIX term structure', source: 'EODHD:VIX/VIX3M' },
  HY_OAS: { module: 'VOL_CREDIT', readingCode: 'HY_OAS', title: 'High-yield spread', source: 'FRED:BAMLH0A0HYM2' },
  YIELD_2S10S: { module: 'YIELDS', readingCode: 'CURVE_2S10S', title: '2s10s curve', source: 'FRED:T10Y2Y' },
  DXY_TREND: { module: 'DOLLAR_POSITIONING', readingCode: 'DXY_TREND', title: 'Dollar trend', source: 'EODHD:DXY.INDX' },
  US_DATA_STACK: { module: 'ECON_DATA', readingCode: 'US_DATA_STACK', title: 'US data stack', source: 'FRED:CPI/GDP/PAYEMS/UNRATE' },
};

export async function buildReadings(
  observationDate: Date,
  config: CompassConfigDefinition,
  isValidation = false,
): Promise<ModuleReading[]> {
  const readings: ModuleReading[] = [];
  const fredStale = config.staleness.stale_limit_fred_rates_days;

  // ================================================================ 1. votes
  const inputRows = await prisma.compassInput.findMany({
    where: { observationDate, isValidation },
  });

  for (const row of inputRows) {
    const meta = VOTING_INPUTS[row.inputCode];
    const sub = (row.subChecks ?? {}) as Record<string, unknown>;
    const stale = sub.stale === true;
    const insufficient = sub.insufficientHistory === true;
    const derived = row.derivedValue === null ? null : Number(row.derivedValue.toString());
    const raw = row.rawValue === null ? null : Number(row.rawValue.toString());

    if (meta) {
      readings.push(
        makeReading({
          moduleCode: meta.module,
          readingCode: meta.readingCode,
          title: meta.title,
          colorBand: row.colorBand as ColorBand,
          isVoting: true,
          weight: config.weights[row.inputCode] ?? VOTING_WEIGHT_FALLBACK,
          valueNumeric: raw,
          valueText: null,
          unit: null,
          sourceCode: meta.source,
          sourceAsOf: observationDate,
          stalenessState: stale ? 'STALE' : insufficient ? 'MISSING' : 'FRESH',
          stalenessDays: typeof sub.staleTradingDays === 'number' ? sub.staleTradingDays : null,
          explanation:
            row.inputCode === 'HY_OAS'
              ? explanation('reading.hy_oas', { level: raw, delta10: derived })
              : row.inputCode === 'VIX_5D_AVG'
                ? explanation('reading.vix', { value: derived ?? raw })
                : row.inputCode === 'VIX_TERM_STRUCTURE'
                  ? explanation('reading.vix_term_structure', { value: raw })
                  : row.inputCode === 'DXY_TREND'
                    ? explanation('reading.dxy_trend', {
                        devPct: derived === null ? null : derived * 100,
                        move5Pct: typeof sub.move5 === 'number' ? sub.move5 * 100 : null,
                      })
                    : row.inputCode === 'US_DATA_STACK'
                      ? explanation('reading.data_stack', {
                          cpi: String((sub.cpi as { band?: string } | undefined)?.band ?? '—'),
                          gdp: String((sub.gdp as { band?: string } | undefined)?.band ?? '—'),
                          jobs: String((sub.jobs as { band?: string } | undefined)?.band ?? '—'),
                        })
                      : row.inputCode === 'YIELD_2S10S'
                        ? sub.curveGreenGated === true
                          ? explanation('reading.curve_2s10s.gated', { level: raw, delta30: derived })
                          : explanation('reading.curve_2s10s', { level: raw, delta30: derived })
                        : null,
        }),
      );
    }

    // R1 — non-voting, but it gates the curve, so it is a Yields reading.
    if (row.inputCode === 'REAL_YIELD_SHOCK') {
      const band = (sub.band as ColorBand | null) ?? null;
      const unavailable = sub.seriesUnavailable === true;
      readings.push(
        makeReading({
          moduleCode: 'YIELDS',
          readingCode: 'R1_REAL_YIELD_SHOCK',
          title: 'Real yield shock (60d)',
          colorBand: band,
          isVoting: false,
          weight: null,
          valueNumeric: derived,
          valueText: null,
          unit: 'bp',
          sourceCode: 'FRED:DFII10',
          sourceAsOf: observationDate,
          stalenessState: unavailable ? 'MISSING' : stale ? 'STALE' : 'FRESH',
          stalenessDays: null,
          explanation: unavailable
            ? explanation('reading.real_yield_shock.unavailable')
            : explanation('reading.real_yield_shock', { bp: derived }),
        }),
      );
    }
  }

  // =============================================== 2. display-only series
  const fetches: SeriesFetch[] = [];
  const tryFetch = async (code: string, fn: () => Promise<DatedValue[]>): Promise<void> => {
    try {
      fetches.push({ code, values: await fn() });
    } catch (err) {
      logger.warn(
        { code, message: (err as Error).message },
        'Compass readings: display series unavailable — reading will render as MISSING',
      );
      fetches.push({ code, values: [] });
    }
  };
  const seriesOf = (code: string): DatedValue[] => fetches.find((f) => f.code === code)?.values ?? [];

  const fredDaysBack = 180;
  await tryFetch('DGS30', async () =>
    toDated(await compassFredClient.fetchSeries(compassFredClient.SERIES.US_30Y, fredDaysBack)));
  await tryFetch('DGS20', async () =>
    toDated(await compassFredClient.fetchSeries(compassFredClient.SERIES.US_20Y, fredDaysBack)));
  await tryFetch('DGS10', async () =>
    toDated(await compassFredClient.fetchSeries(compassFredClient.SERIES.US_10Y, fredDaysBack)));
  await tryFetch('T10YIE', async () =>
    toDated(await compassFredClient.fetchSeries(compassFredClient.SERIES.BREAKEVEN_10Y, fredDaysBack)));
  await tryFetch('DFII10', async () =>
    toDated(await compassFredClient.fetchSeries(compassFredClient.SERIES.REAL_YIELD_10Y, fredDaysBack)));
  await tryFetch('BAA10Y', async () =>
    toDated(await compassFredClient.fetchSeries(compassFredClient.SERIES.BAA_SPREAD, fredDaysBack)));
  await tryFetch('THREEFYTP10', async () =>
    toDated(await compassFredClient.fetchSeries(compassFredClient.SERIES.TERM_PREMIUM_KW, fredDaysBack)));
  await tryFetch('DGS2', async () =>
    toDated(await compassFredClient.fetchSeries(compassFredClient.SERIES.US_02Y, fredDaysBack)));

  let jgb: Record<string, DatedValue[]> = {};
  try {
    const raw = await mofClient.fetchJgbYields(['2Y', '10Y', '30Y']);
    jgb = raw as unknown as Record<string, DatedValue[]>;
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'Compass readings: JGB unavailable');
  }

  const de: Record<string, DatedValue[]> = {};
  for (const key of ['DE_2Y', 'DE_10Y', 'DE_30Y'] as const) {
    try {
      de[key] = await bundesbankClient.fetchSeries(key);
    } catch (err) {
      logger.warn({ key, message: (err as Error).message }, 'Compass readings: Bundesbank unavailable');
      de[key] = [];
    }
  }

  const policy: Record<string, DatedValue[]> = { US: [], JP: [], XM: [], GB: [] };
  try {
    for (const s of await bisClient.fetchPolicyRates(['US', 'JP', 'XM'])) {
      policy[s.area] = s.observations;
    }
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'Compass readings: BIS policy rates unavailable');
  }
  // The BoE is not in the BIS bulk file this system reads, so the Bank Rate
  // comes from the admin panel — the same UK_BOE_RATE rows EdgeFinder already
  // maintains, read for their level rather than their bps change. One entry,
  // two consumers. See admin-policy-rate.source.ts.
  try {
    policy.GB = await manualPolicyRateSeries('UK_BOE_RATE');
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'Compass readings: BoE Bank Rate unavailable');
  }

  // ------------------------------------------------------------ YIELDS extras
  const add = (
    moduleCode: ModuleCode,
    readingCode: string,
    title: string,
    series: DatedValue[],
    sourceCode: string,
    unit: string | null,
    explain: (v: number | null) => ReturnType<typeof explanation> | null,
    staleLimit = fredStale,
  ): number | null => {
    const l = latest(series, observationDate, staleLimit);
    readings.push(
      makeReading({
        moduleCode,
        readingCode,
        title,
        valueNumeric: l.value,
        valueText: null,
        unit,
        sourceCode,
        sourceAsOf: l.asOfDate,
        stalenessState: l.state,
        stalenessDays: l.days,
        explanation: explain(l.value),
      }),
    );
    return l.value;
  };

  const real10 = add('YIELDS', 'REAL_YIELD_10Y', '10-year real yield', seriesOf('DFII10'), 'FRED:DFII10', '%', () => null);
  add('YIELDS', 'BREAKEVEN_10Y', '10-year breakeven', seriesOf('T10YIE'), 'FRED:T10YIE', '%', (v) =>
    explanation('reading.breakeven', { value: v, real: real10 }));

  // 10s30s, 60-day change (R2 — display only, LOW confidence, one leg fails out of sample)
  const d30 = seriesOf('DGS30');
  const d10 = seriesOf('DGS10');
  if (d30.length > 0 && d10.length > 0) {
    const byDate = new Map(d10.map((o) => [o.date.getTime(), o.value]));
    const spread: DatedValue[] = d30
      .filter((o) => byDate.has(o.date.getTime()))
      .map((o) => ({ date: o.date, value: o.value - (byDate.get(o.date.getTime()) as number) }));
    const cal = spread.length ? generateTradingDays(spread[0].date, observationDate) : [];
    const clean = buildCleanSeries(spread, cal, observationDate, fredStale);
    const chg = obsChangeFromClean(clean.series, 60);
    const l = latest(spread, observationDate, fredStale);
    readings.push(
      makeReading({
        moduleCode: 'YIELDS',
        readingCode: 'LONG_END_STEEPENING',
        title: '10s30s, 60-day change',
        valueNumeric: chg === null ? null : chg * 100,
        valueText: null,
        unit: 'bp',
        sourceCode: 'FRED:DGS30-DGS10',
        sourceAsOf: l.asOfDate,
        stalenessState: clean.isStale ? 'STALE' : l.state,
        stalenessDays: l.days,
        explanation: explanation('reading.long_end_steepening', { bp: chg === null ? null : chg * 100 }),
      }),
    );
  }

  // 20s30s — explicitly framed as a supply artifact, never as stress.
  const d20 = seriesOf('DGS20');
  if (d30.length > 0 && d20.length > 0) {
    const by20 = new Map(d20.map((o) => [o.date.getTime(), o.value]));
    const spread: DatedValue[] = d30
      .filter((o) => by20.has(o.date.getTime()))
      .map((o) => ({ date: o.date, value: o.value - (by20.get(o.date.getTime()) as number) }));
    add('YIELDS', 'TWENTY_THIRTY', '20s30s spread', spread, 'FRED:DGS30-DGS20', 'pp', (v) =>
      explanation('reading.twenty_thirty', { value: v }));
  }

  // Term premium, from Kim-Wright alone.
  //
  // ── WHY ONLY ONE MODEL NOW ────────────────────────────────────────────────
  // This displayed ACM and Kim-Wright side by side, deliberately, because the
  // gap between two estimates of the same unobservable quantity is the honest
  // measure of how well it can be known. That framing was right and is kept in
  // the reading's copy — what changed is the cost of the second series.
  //
  // ACM was the ONLY manually refreshed source in Compass: the NY Fed publishes
  // it as a 10MB legacy .xls, not on FRED, so it shipped as a checked-in CSV
  // with a documented monthly refresh. Against 40+ indicators already under
  // manual maintenance, a display-only series carrying its own recurring chore
  // is the wrong trade — and a forgotten refresh degrades quietly into a stale
  // number sitting next to fresh ones.
  //
  // Kim-Wright is daily, automatic, and already ingesting from FRED. It stays.
  // The uncertainty ACM was there to demonstrate is stated in the reading's
  // static copy instead of being shown — see READING_STATIC.TERM_PREMIUM_KW.
  //
  // The removed code is in git history at this path; acm-source.ts and its CSV
  // are archived alongside the research material rather than deleted. See the
  // Phase C handover for the full reasoning.
  const kwLatest = latest(seriesOf('THREEFYTP10'), observationDate, fredStale);
  readings.push(
    makeReading({
      moduleCode: 'YIELDS',
      readingCode: 'TERM_PREMIUM_KW',
      title: 'Term premium (Kim-Wright)',
      valueNumeric: kwLatest.value,
      valueText: null,
      unit: 'pp',
      sourceCode: 'FRED:THREEFYTP10',
      sourceAsOf: kwLatest.asOfDate,
      stalenessState: kwLatest.state,
      stalenessDays: kwLatest.days,
      explanation:
        kwLatest.value !== null
          ? explanation('reading.term_premium_single', { kw: kwLatest.value })
          : null,
    }),
  );

  // 2Y minus policy — the anchor. A 2-year is uninterpretable without it.
  const anchor = (
    label: string,
    readingCode: string,
    twoYear: DatedValue[],
    pol: DatedValue[],
    source: string,
  ): void => {
    const ty = latest(twoYear, observationDate, fredStale);
    const pr = latest(pol, observationDate, fredStale);
    const gapBp = ty.value !== null && pr.value !== null ? (ty.value - pr.value) * 100 : null;
    readings.push(
      makeReading({
        moduleCode: 'YIELDS',
        readingCode,
        title: `${label} 2-year vs policy`,
        valueNumeric: gapBp,
        valueText: null,
        unit: 'bp',
        sourceCode: source,
        sourceAsOf: ty.asOfDate,
        stalenessState: ty.value === null || pr.value === null ? 'MISSING' : ty.state,
        stalenessDays: ty.days,
        explanation: explanation('reading.two_year_vs_policy', {
          country: label,
          twoYear: ty.value,
          policy: pr.value,
          gapBp,
        }),
      }),
    );
  };
  anchor('US', 'TWO_YEAR_VS_POLICY_US', seriesOf('DGS2'), policy.US, 'FRED:DGS2 / BIS:CBPOL_US');
  anchor('Japan', 'TWO_YEAR_VS_POLICY_JP', jgb['2Y'] ?? [], policy.JP, 'MOF:JGB2Y / BIS:CBPOL_JP');
  anchor('Euro area', 'TWO_YEAR_VS_POLICY_DE', de.DE_2Y ?? [], policy.XM, 'BBK:DE2Y / BIS:CBPOL_XM');

  // ------------------------------------------------------- VOL_CREDIT extras
  add('VOL_CREDIT', 'BAA_SPREAD', 'Baa credit spread', seriesOf('BAA10Y'), 'FRED:BAA10Y', 'pp', (v) =>
    explanation('reading.baa_spread', { value: v }));

  // ---------------------------------------------------- POLICY_STANCE
  const pol = (
    label: string,
    code: string,
    s: DatedValue[],
    src: string,
    staleLimit = 10,
  ): number | null =>
    add('POLICY_STANCE', code, `${label} policy rate`, s, src, '%', (v) =>
      explanation('reading.policy_rate', { bank: label, value: v }), staleLimit);
  const fed = pol('Federal Reserve', 'POLICY_RATE_US', policy.US, 'BIS:CBPOL_US');
  const boj = pol('Bank of Japan', 'POLICY_RATE_JP', policy.JP, 'BIS:CBPOL_JP');
  pol('ECB', 'POLICY_RATE_XM', policy.XM, 'BIS:CBPOL_XM');
  // Hand-entered, so it gets the staleness treatment that makes a forgotten
  // update loud. The limit is wider than the BIS series' 10 days because those
  // are daily observations while this is a step function that only moves at a
  // meeting — see BOE_STALE_LIMIT_DAYS for the arithmetic.
  const boe = pol(
    'Bank of England',
    'POLICY_RATE_GB',
    policy.GB,
    'ADMIN:UK_BOE_RATE',
    BOE_STALE_LIMIT_DAYS,
  );

  // Hedged 30-year pickup for a JPY investor. The single most striking number in
  // the study: negative every day since 28 July 2022.
  const us30 = latest(seriesOf('DGS30'), observationDate, fredStale);
  const jgb30 = latest(jgb['30Y'] ?? [], observationDate, 10);
  if (us30.value !== null && jgb30.value !== null && fed !== null && boj !== null) {
    const pickup = us30.value - (fed - boj) - jgb30.value;
    readings.push(
      makeReading({
        moduleCode: 'POLICY_STANCE',
        readingCode: 'HEDGED_30Y_JPY_PICKUP',
        title: 'Hedged 30-year pickup, JPY investor',
        valueNumeric: pickup,
        valueText: null,
        unit: 'pp',
        sourceCode: 'FRED:DGS30 / MOF:JGB30Y / BIS:CBPOL_US,JP',
        sourceAsOf: us30.asOfDate,
        stalenessState: jgb30.state === 'STALE' ? 'STALE' : us30.state,
        stalenessDays: us30.days,
        explanation: explanation('reading.hedged_jgb_pickup', { value: pickup }),
      }),
    );

    readings.push(
      makeReading({
        moduleCode: 'POLICY_STANCE',
        readingCode: 'JPY_CARRY',
        title: 'US-Japan policy differential',
        valueNumeric: fed - boj,
        valueText: null,
        unit: 'pp',
        sourceCode: 'BIS:CBPOL_US,JP',
        sourceAsOf: observationDate,
        stalenessState: 'FRESH',
        stalenessDays: 0,
        explanation: explanation('reading.jpy_carry', { value: fed - boj }),
      }),
    );
  }

  // GBP-JPY carry. Blocked entirely until now: BIS carries no UK series, so
  // there was no Bank Rate in Compass to difference against the BoJ's.
  if (boe !== null && boj !== null) {
    readings.push(
      makeReading({
        moduleCode: 'POLICY_STANCE',
        readingCode: 'GBP_CARRY',
        title: 'UK-Japan policy differential',
        valueNumeric: boe - boj,
        valueText: null,
        unit: 'pp',
        sourceCode: 'ADMIN:UK_BOE_RATE / BIS:CBPOL_JP',
        sourceAsOf: observationDate,
        stalenessState: 'FRESH',
        stalenessDays: 0,
        explanation: explanation('reading.gbp_carry', { value: boe - boj }),
      }),
    );
  }

  return readings;
}

/**
 * Phase B replay engine (B1).
 *
 * A general historical replay of the Compass rules over any date range with any
 * supplied config object, writing per-date CSV to the run's output directory.
 * (The original research harness wrote to research/phase-b/output, which is now
 * archived outside this repo in Lucid-Research/ — see the Phase C handover.)
 * It NEVER writes compass_inputs / compass_classifications / compass_config.
 *
 * FIDELITY
 * --------
 * Every scoring decision is delegated to the SHIPPED pure modules — nothing is
 * re-implemented:
 *   compass-bands.ts               band evaluation for all 6 inputs + 3 sub-checks
 *   compass-calculations.ts        YoY / QoQ / Sahm / NFP / trajectory
 *   compass-staleness.ts           forward-fill, observation-indexed lookbacks
 *   compass-curve-state-machine.ts 2s10s inversion episodes + red window
 *   compass-shock-layer.ts         Trigger A / Trigger B / expiry mechanics
 *   compass-classifier-logic.ts    vote weights, candidate regime, persistence
 *   compass-override-gates.ts      rate gate / fed-constraint gate
 *
 * What this file contributes is only the PLUMBING each input service performs
 * around those calls (fetch window -> filter <= t -> reference calendar ->
 * buildCleanSeries -> derive -> evaluate), reproduced step for step from the
 * corresponding *-input.service.ts, plus the classifier's daily ordering.
 *
 * DELIBERATE DIFFERENCES FROM LIVE (all reported in FINDINGS.md §3):
 *   - Macro sub-checks can run POINT-IN-TIME (ALFRED vintages). Live is
 *     latest-vintage, which is look-ahead. Both modes are implemented so the
 *     bias can be measured rather than assumed.
 *   - The 2s10s episode scan can be seeded from the TRUE START OF HISTORY
 *     instead of the live 730-calendar-day window. Both modes implemented.
 *   - Market series come from FRED/Yahoo rather than EODHD, because the EODHD
 *     account returns only 12 months of history (see §3).
 */
import {
  evaluateVix,
  evaluateHyOas,
  evaluate2s10s,
  evaluateDxyTrend,
  evaluateVixTermStructure,
  evaluateCpiTrajectory,
  evaluateGdpLevel,
  evaluateJobs,
  aggregateUsDataStack,
  evaluateRealYieldShock,
  type ColorBand,
} from '@modules/edgefinder/services/compass/compass-bands';
import {
  computeYoYSequence,
  computeQoQSequence,
  computeSahmRule,
  computeRecentNFPChanges,
  detectTrajectory,
} from '@modules/edgefinder/services/compass/compass-calculations';
import {
  buildCleanSeries,
  smaFromClean,
  obsChangeFromClean,
} from '@modules/edgefinder/services/compass/compass-staleness';
import {
  scanForMostRecentEpisode,
  isWithinRedWindow,
  type CurveObservation,
} from '@modules/edgefinder/services/compass/compass-curve-state-machine';
import {
  evaluateTriggerA,
  evaluateTriggerB,
  advanceShockState,
  type ShockObservation,
  type ShockTriggerState,
} from '@modules/edgefinder/services/compass/compass-shock-layer';
import {
  sumVoteWeights,
  determineCandidateRegime,
  resolveActiveRegime,
  type Regime,
} from '@modules/edgefinder/services/compass/compass-classifier-logic';
import {
  isRegimePathRiskOff,
  computeRateGateHawkish,
  computeUs02ySma,
  evaluateRateGate,
  evaluateFedConstraintGate,
} from '@modules/edgefinder/services/compass/compass-override-gates';
import type { CompassConfigDefinition } from '@modules/edgefinder/services/compass/compass-config.types';

import { addDays, generateTradingDays, slice, ymd, type DatedValue } from './series';
import { asOfLevels, latestVintageLevels } from './pit-macro';

// ------------------------------------------------------------------ options

export type MacroMode = 'pit' | 'live';
export type CurveSeed = 'full' | 'window730';

export interface ReplaySources {
  vix: DatedValue[];
  /** 10y TIPS real yield (FRED DFII10). Only needed for the proposed alternative yields rule. */
  dfii10?: DatedValue[];
  vix3m: DatedValue[];
  dxy: DatedValue[];
  hyOas: DatedValue[];
  t10y2y: DatedValue[];
  dgs2: DatedValue[];
  usdJpy: DatedValue[];
}

export interface ReplayOptions {
  from: Date;
  to: Date;
  config: CompassConfigDefinition;
  sources: ReplaySources;
  /** 'pit' = ALFRED vintages (correct); 'live' = latest vintage (reproduces live look-ahead). */
  macroMode: MacroMode;
  /** 'full' = seed the inversion state machine from the true start of T10Y2Y history. */
  curveSeed: CurveSeed;
  /** Calendar days of silent warm-up before `from` so shock/persistence state is seeded. 0 = cold start (what live backfill does). */
  warmupDays: number;
  fedConstraint: 'FREE' | 'CONSTRAINED';
  /**
   * How to treat HY OAS when its real series is unavailable (FRED truncated
   * every ICE BofA OAS series to 2023-09-11+).
   *   'none'        use the supplied series as-is (real, or a proxy CSV)
   *   'unavailable' reproduce the live code's own branch: YELLOW, delta null
   *   'force_red'   pin the band RED — the maximum-credit-stress UPPER BOUND.
   * Running a window under both 'unavailable' and 'force_red' brackets the
   * result, so a failure that survives both is provably not caused by the
   * missing series.
   */
  hyOasMode?: 'none' | 'unavailable' | 'force_red';
  /**
   * B8 — ALTERNATIVE RULE, not shipped behaviour. When set, the CPI sub-check
   * cannot score GREEN while the latest headline YoY print is at or above this
   * level; a falling-but-still-hot trajectory is demoted GREEN -> YELLOW.
   * Applied here as a supplied-config variation. compass-bands.ts is untouched.
   */
  cpiLevelFloor?: number;
  /**
   * B8 variant 2 — a hot LEVEL scores RED outright, regardless of trajectory.
   * Unlike the floor (which can only demote GREEN->YELLOW and therefore can
   * never add a Risk-Off day), this can push US_DATA_STACK toward RED and so
   * is the only level-based change that can affect stress detection.
   */
  cpiLevelRed?: number;
  /**
   * B9 PROPOSED RULE Y1 (evidence in b9b_rule_validation.py) — an ALTERNATIVE
   * yields rule, tested here, not shipped. The shipped 2s10s rule scores GREEN
   * on a steep curve, which is exactly the shape a long-end selloff produces:
   * across the 28 post-1990 term-premium episodes the curve input printed GREEN
   * at the term-premium peak in 26 of them. Y1 adds a REAL-YIELD SHOCK veto:
   * the yields input may not print GREEN, and prints RED, when the 10-year TIPS
   * real yield has risen by at least `realYieldShockBp` over 60 trading days.
   */
  realYieldShockBp?: number;
  /**
   * PHASE C C6.1 — the shipped 2s10s GREEN gate. When true (and the config
   * carries `yields.curve_green_requires_no_real_shock`), the curve's GREEN
   * clause is suppressed while R1 is RED. Defaults to whatever the config says;
   * set false to measure the counterfactual.
   */
  curveGateEnabled?: boolean;
  /**
   * PHASE C C6.2 — the RESCALING REPORT ONLY. Gives R1 a vote at this weight,
   * taking the scale from 8.0 to 8.0 + weight. NOT shipped behaviour: R1 votes
   * nowhere in production this phase. Requires a synthetic config whose
   * `weights` includes REAL_YIELD_SHOCK, because `sumVoteWeights` throws on an
   * unknown input code and `resolveForDate` throws if the weights do not sum to
   * exactly 8.0 — which is why this can only ever be driven from a replay.
   */
  realYieldVotes?: boolean;
  label?: string;
}

export interface ReplayRow {
  date: string;
  inWindow: boolean;

  vixRaw: number | null;
  vix5dAvg: number | null;
  vixBand: ColorBand;
  vixNote: string;

  tsRatio: number | null;
  vixTsBand: ColorBand;
  vixTsNote: string;

  oasLevel: number | null;
  oasDelta10: number | null;
  oasBand: ColorBand;
  oasNote: string;

  t10y2y: number | null;
  delta30: number | null;
  inversionStart: string | null;
  unInversionDate: string | null;
  insideRedWindow: boolean;
  realYield60dBp: number | null;
  /** R1's band. Null before DFII10 begins in 2003, or when it cannot be computed. */
  realYieldBand: ColorBand | null;
  /** True when C6.1 actually suppressed a GREEN the curve would otherwise have voted. */
  curveGreenGated: boolean;
  curveBand: ColorBand;
  curveNote: string;

  dxyClose: number | null;
  dxyDev: number | null;
  dxyMove5: number | null;
  dxyBand: ColorBand;
  dxyNote: string;

  cpiBand: ColorBand;
  cpiYoY3: string;
  cpiLatestYoY: number | null;
  gdpBand: ColorBand;
  gdpQoQ2: string;
  jobsBand: ColorBand;
  jobsNfp3: string;
  sahmDelta: number | null;
  dataStackBand: ColorBand;

  greenWeight: number;
  yellowWeight: number;
  redWeight: number;
  candidateRegime: Regime;
  activeRegime: Regime;
  persistenceDaysCount: number;

  usdJpyClose: number | null;
  triggerAFired: boolean;
  triggerBFired: boolean;
  shockAActive: boolean;
  shockBActive: boolean;
  finalRegime: Regime;

  us02yClose: number | null;
  us02ySma21: number | null;
  rateGateHawkish: boolean;
  regimePathRiskOff: boolean;
  overridesActive: string;
}

// ------------------------------------------------------------------ helpers

const MARKET = (c: CompassConfigDefinition) => c.staleness.stale_limit_market_data_days;
const FREDL = (c: CompassConfigDefinition) => c.staleness.stale_limit_fred_rates_days;

function lastOf<T>(a: T[]): T | undefined {
  return a.length ? a[a.length - 1] : undefined;
}

function fmtArr(a: number[], dp = 3): string {
  return a.map((v) => v.toFixed(dp)).join(' ');
}

// ------------------------------------------------------------------ per-input derivations
// Each mirrors its *-input.service.ts step for step.

/** vix-input.service.ts (DAYS_BACK = 15, AVG_LOOKBACK_OBS = 5). */
function deriveVix(t: Date, src: DatedValue[], cfg: CompassConfigDefinition) {
  const raw = slice(src, addDays(t, -15), t);
  if (raw.length === 0) return { raw: null, avg: null, band: 'YELLOW' as ColorBand, note: 'no_rows' };
  const refCal = generateTradingDays(raw[0].date, t);
  const clean = buildCleanSeries(raw, refCal, t, MARKET(cfg));
  const todayClose = raw[raw.length - 1].value;
  if (clean.series.length < 5) {
    return { raw: todayClose, avg: null, band: 'YELLOW' as ColorBand, note: 'insufficientHistory' };
  }
  if (clean.isStale) {
    return { raw: todayClose, avg: null, band: 'YELLOW' as ColorBand, note: `stale(${clean.staleTradingDays})` };
  }
  const cleanToday = clean.series[clean.series.length - 1].value;
  const avg = smaFromClean(clean.series, 5);
  if (avg === null) return { raw: cleanToday, avg: null, band: 'YELLOW' as ColorBand, note: 'sma_null' };
  return { raw: cleanToday, avg, band: evaluateVix(avg, cfg), note: '' };
}

/** vix-term-structure-input.service.ts (DAYS_BACK = 15). */
function deriveVixTs(t: Date, vix: DatedValue[], vix3m: DatedValue[], cfg: CompassConfigDefinition) {
  const v = slice(vix, addDays(t, -15), t);
  const v3 = slice(vix3m, addDays(t, -15), t);
  if (v.length === 0 || v3.length === 0) {
    return { ratio: null, band: 'YELLOW' as ColorBand, note: 'zero_rows_one_side' };
  }
  const start = v[0].date.getTime() <= v3[0].date.getTime() ? v[0].date : v3[0].date;
  const refCal = generateTradingDays(start, t);
  const cv = buildCleanSeries(v, refCal, t, MARKET(cfg));
  const cv3 = buildCleanSeries(v3, refCal, t, MARKET(cfg));
  const a = lastOf(cv.series);
  const b = lastOf(cv3.series);
  const bothPresent =
    a !== undefined && b !== undefined &&
    a.date.getTime() === t.getTime() && b.date.getTime() === t.getTime();
  const eitherStale = cv.isStale || cv3.isStale;
  let ratio: number | null = null;
  if (bothPresent && !eitherStale && b!.value !== 0) ratio = a!.value / b!.value;
  return {
    ratio,
    band: ratio === null ? ('YELLOW' as ColorBand) : evaluateVixTermStructure(ratio, cfg),
    note: ratio === null ? (eitherStale ? 'stale' : 'not_both_present') : '',
  };
}

/** dxy-trend-input.service.ts (DAYS_BACK = 90, SMA 50, move 5). */
function deriveDxy(t: Date, src: DatedValue[], cfg: CompassConfigDefinition) {
  const raw = slice(src, addDays(t, -90), t);
  if (raw.length === 0) return { close: null, dev: null, move5: null, band: 'YELLOW' as ColorBand, note: 'no_rows' };
  const refCal = generateTradingDays(raw[0].date, t);
  const clean = buildCleanSeries(raw, refCal, t, MARKET(cfg));
  const todayClose = raw[raw.length - 1].value;
  if (clean.series.length < 50) {
    return { close: todayClose, dev: null, move5: null, band: 'YELLOW' as ColorBand, note: 'insufficientHistory' };
  }
  if (clean.isStale) {
    return { close: todayClose, dev: null, move5: null, band: 'YELLOW' as ColorBand, note: `stale(${clean.staleTradingDays})` };
  }
  const cleanToday = clean.series[clean.series.length - 1].value;
  const sma50 = smaFromClean(clean.series, 50);
  const move5Change = obsChangeFromClean(clean.series, 5);
  if (sma50 === null || move5Change === null) {
    return { close: cleanToday, dev: null, move5: null, band: 'YELLOW' as ColorBand, note: 'insufficient' };
  }
  const dev = Math.abs(cleanToday / sma50 - 1);
  const atLookback = clean.series[clean.series.length - 1 - 5].value;
  const move5 = Math.abs(cleanToday / atLookback - 1);
  return { close: cleanToday, dev, move5, band: evaluateDxyTrend(dev, move5, cfg), note: '' };
}

/** hy-oas-input.service.ts (DAYS_BACK = 50, delta10, MIN 11). */
function deriveHyOas(t: Date, src: DatedValue[], cfg: CompassConfigDefinition,
                     mode: 'none' | 'unavailable' | 'force_red') {
  if (mode === 'unavailable') return { level: null, delta10: null, band: 'YELLOW' as ColorBand, note: 'series_unavailable' };
  if (mode === 'force_red') return { level: null, delta10: null, band: 'RED' as ColorBand, note: 'forced_red_upper_bound' };
  const raw = slice(src, addDays(t, -50), t);
  if (raw.length === 0) return { level: null, delta10: null, band: 'YELLOW' as ColorBand, note: 'no_rows' };
  const refCal = generateTradingDays(raw[0].date, t);
  const clean = buildCleanSeries(raw, refCal, t, FREDL(cfg));
  const last = raw[raw.length - 1].value;
  if (clean.series.length < 11) {
    return { level: last, delta10: null, band: 'YELLOW' as ColorBand, note: 'insufficientHistory' };
  }
  if (clean.isStale) {
    return { level: last, delta10: null, band: 'YELLOW' as ColorBand, note: `stale(${clean.staleTradingDays})` };
  }
  const level = clean.series[clean.series.length - 1].value;
  const delta10 = obsChangeFromClean(clean.series, 10);
  return { level, delta10, band: evaluateHyOas(level, delta10, cfg), note: '' };
}

/** us-data-stack-input.service.ts, with a point-in-time vs latest-vintage switch. */
function deriveDataStack(t: Date, cfg: CompassConfigDefinition, mode: MacroMode, cpiFloor?: number, cpiRed?: number) {
  const get = mode === 'pit' ? asOfLevels : latestVintageLevels;
  const cpiLevels = get('CPIAUCSL', t);
  const gdpLevels = get('GDP', t);
  const payemsLevels = get('PAYEMS', t);
  const unrateLevels = get('UNRATE', t);

  const yoy = computeYoYSequence(cpiLevels).filter((v): v is number => v !== null);
  let cpiBand: ColorBand = yoy.length >= 3 ? evaluateCpiTrajectory(detectTrajectory(yoy.slice(-3))) : 'YELLOW';
  const latestYoY = yoy.length ? yoy[yoy.length - 1] : null;
  if (cpiFloor !== undefined && cpiBand === 'GREEN' && latestYoY !== null && latestYoY >= cpiFloor) {
    cpiBand = 'YELLOW';   // B8 level floor: falling, but not yet low enough to be GREEN
  }
  if (cpiRed !== undefined && latestYoY !== null && latestYoY >= cpiRed) {
    cpiBand = 'RED';      // B8 variant 2: a hot level is RED whatever the trajectory
  }

  const qoq = computeQoQSequence(gdpLevels).filter((v): v is number => v !== null);
  const gdpBand = evaluateGdpLevel(qoq, cfg);

  const sahm = computeSahmRule(unrateLevels);
  const nfp = computeRecentNFPChanges(payemsLevels);
  const jobsBand = evaluateJobs(sahm?.triggered ?? false, nfp, cfg);

  return {
    cpiBand, gdpBand, jobsBand,
    overall: aggregateUsDataStack(cpiBand, gdpBand, jobsBand, cfg),
    yoy3: yoy.slice(-3), qoq2: qoq.slice(-2), nfp3: nfp,
    latestYoY,
    sahmDelta: sahm ? sahm.delta : null,
  };
}

// ------------------------------------------------------------------ engine

export function runReplay(opts: ReplayOptions): ReplayRow[] {
  const cfg = opts.config;
  const start = opts.warmupDays > 0 ? addDays(opts.from, -opts.warmupDays) : opts.from;
  const days = generateTradingDays(start, opts.to);

  const rows: ReplayRow[] = [];
  // Rolling stores that stand in for the compass_inputs table the live
  // classifier re-reads. Populated only by this replay's own emitted rows —
  // identical to what a live sequential backfill would have available.
  const vixCloseHist: ShockObservation[] = [];
  const vix5dHist: ShockObservation[] = [];
  const oasHist: ShockObservation[] = [];
  const jpyHist: ShockObservation[] = [];

  let prior: { activeRegime: Regime; candidateRegime: Regime; persistenceDaysCount: number } | null = null;
  let shockA: ShockTriggerState | null = null;
  let shockB: ShockTriggerState | null = null;

  for (const t of days) {
    // ---- inputs
    const v = deriveVix(t, opts.sources.vix, cfg);
    const vts = deriveVixTs(t, opts.sources.vix, opts.sources.vix3m, cfg);
    const dxy = deriveDxy(t, opts.sources.dxy, cfg);
    const oas = deriveHyOas(t, opts.sources.hyOas, cfg, opts.hyOasMode ?? 'none');
    const ds = deriveDataStack(t, cfg, opts.macroMode, opts.cpiLevelFloor, opts.cpiLevelRed);

    // ---- 2s10s (needs the Jobs sub-check band from the same date)
    const curveWindow = slice(opts.sources.t10y2y, addDays(t, -730), t);
    const scanObs: CurveObservation[] =
      opts.curveSeed === 'full' ? slice(opts.sources.t10y2y, new Date(Date.UTC(1900, 0, 1)), t) : curveWindow;
    let curveBand: ColorBand = 'YELLOW';
    let delta30: number | null = null;
    let t10y2y: number | null = null;
    let inversionStart: string | null = null;
    let unInversionDate: string | null = null;
    let insideRed = false;
    let curveNote = '';
    let realYield60dBp: number | null = null;
    let realYieldBand: ColorBand | null = null;
    let curveGreenGated = false;
    if (curveWindow.length === 0) {
      curveNote = 'no_rows';
    } else {
      t10y2y = curveWindow[curveWindow.length - 1].value;
      const refCal = generateTradingDays(curveWindow[0].date, t);
      const clean = buildCleanSeries(curveWindow, refCal, t, FREDL(cfg));
      const insufficient = clean.series.length < 31;
      delta30 = insufficient || clean.isStale ? null : obsChangeFromClean(clean.series, 30);
      const { mostRecentEpisode } = scanForMostRecentEpisode(
        scanObs,
        cfg.yieldCurve.curve_inversion_min_obs,
        cfg.yieldCurve.curve_uninversion_min_obs,
      );
      inversionStart = mostRecentEpisode ? ymd(mostRecentEpisode.inversionStart) : null;
      unInversionDate = mostRecentEpisode?.unInversionDate ? ymd(mostRecentEpisode.unInversionDate) : null;
      insideRed =
        mostRecentEpisode?.unInversionDate != null &&
        isWithinRedWindow(scanObs, mostRecentEpisode.unInversionDate, t, cfg.yieldCurve.curve_red_window_days);
      // --- R1_REAL_YIELD_SHOCK (Phase C). Computed whenever DFII10 is
      // available, independently of whether it votes or gates anything, so the
      // shadow reading is always on the row.
      if (opts.sources.dfii10) {
        const rw = slice(opts.sources.dfii10, addDays(t, -140), t);
        if (rw.length > 61) {
          const refR = generateTradingDays(rw[0].date, t);
          const cr = buildCleanSeries(rw, refR, t, FREDL(cfg));
          const chg60 = obsChangeFromClean(cr.series, 60);
          if (chg60 !== null && !cr.isStale) {
            realYield60dBp = chg60 * 100;
            realYieldBand = evaluateRealYieldShock(realYield60dBp, cfg);
          }
        }
      }

      // --- C6.1: the curve GREEN gate.
      const gateOn = opts.curveGateEnabled ?? true;
      const ungatedBand = evaluate2s10s(t10y2y, delta30, insideRed, ds.jobsBand, cfg);
      curveBand = gateOn
        ? evaluate2s10s(t10y2y, delta30, insideRed, ds.jobsBand, cfg, realYieldBand)
        : ungatedBand;
      curveGreenGated = ungatedBand === 'GREEN' && curveBand !== 'GREEN';
      if (curveGreenGated) {
        curveNote = curveNote ? `${curveNote};curveGreenGated` : 'curveGreenGated';
      }

      // --- proposed RULE Y1: real-yield shock veto (alternative rule under test)
      if (opts.realYieldShockBp !== undefined && opts.sources.dfii10) {
        const rw = slice(opts.sources.dfii10, addDays(t, -140), t);
        if (rw.length > 61) {
          const refR = generateTradingDays(rw[0].date, t);
          const cr = buildCleanSeries(rw, refR, t, FREDL(cfg));
          const chg60 = obsChangeFromClean(cr.series, 60);
          if (chg60 !== null && !cr.isStale) {
            realYield60dBp = chg60 * 100;
            if (realYield60dBp >= opts.realYieldShockBp) {
              curveBand = 'RED';
              curveNote = curveNote ? `${curveNote};realYieldShock` : 'realYieldShock';
            }
          }
        }
      }
      if (insufficient) curveNote = 'insufficientHistory';
      else if (clean.isStale) curveNote = `stale(${clean.staleTradingDays})`;
    }

    // ---- votes
    const inputsWithBand = [
      { inputCode: 'VIX_5D_AVG', colorBand: v.band },
      { inputCode: 'HY_OAS', colorBand: oas.band },
      { inputCode: 'YIELD_2S10S', colorBand: curveBand },
      { inputCode: 'DXY_TREND', colorBand: dxy.band },
      { inputCode: 'VIX_TERM_STRUCTURE', colorBand: vts.band },
      { inputCode: 'US_DATA_STACK', colorBand: ds.overall },
    ];
    // Rescaling report only — see ReplayOptions.realYieldVotes. A null band
    // (pre-2003, stale, short history) cannot vote: it would otherwise be
    // silently counted as whatever ColorBand it was coerced to.
    if (opts.realYieldVotes && realYieldBand !== null) {
      inputsWithBand.push({ inputCode: 'REAL_YIELD_SHOCK', colorBand: realYieldBand });
    }
    const voteWeights = sumVoteWeights(inputsWithBand, cfg);
    const candidateRegime = determineCandidateRegime({ voteWeights }, cfg);

    // ---- persistence
    const resolved = resolveActiveRegime({ candidateRegime, prior }, cfg);

    // ---- shock layer plumbing series (mirrors readInputSeries over [t-30d, t])
    const jpyRow = lastOf(slice(opts.sources.usdJpy, addDays(t, -10), t));
    if (v.raw !== null) vixCloseHist.push({ date: t, value: v.raw });
    if (v.avg !== null) vix5dHist.push({ date: t, value: v.avg });
    if (oas.level !== null) oasHist.push({ date: t, value: oas.level });
    if (jpyRow) jpyHist.push({ date: t, value: jpyRow.value });

    const from30 = addDays(t, -30).getTime();
    const win = (a: ShockObservation[]) => a.filter((o) => o.date.getTime() >= from30);
    const vixCloses = win(vixCloseHist);
    const vix5dAvgs = win(vix5dHist);
    const oasLevels = win(oasHist);
    const jpyCloses = win(jpyHist);

    const triggerA = evaluateTriggerA(t, {
      vixCloses,
      oasLevels,
      vixThreshold: cfg.shockLayer.shock_a_vix_threshold,
      oasDelta5Threshold: cfg.shockLayer.shock_a_oas_delta5,
    });
    const triggerB = evaluateTriggerB(t, {
      usdJpyCloses: jpyCloses,
      vix5dAvgs,
      usdJpyMove5Threshold: cfg.shockLayer.shock_b_usdjpy_move5,
    });

    const nextA = advanceShockState(shockA, triggerA.fired, t, vixCloses, cfg.shockLayer.shock_expiry_trading_days);
    const nextB = advanceShockState(shockB, triggerB.fired, t, jpyCloses, cfg.shockLayer.shock_expiry_trading_days);
    shockA = nextA;
    shockB = nextB;

    const finalRegime: Regime = nextA.active ? 'Risk-Off' : resolved.activeRegime;

    // ---- gates
    const regimePathRiskOff = isRegimePathRiskOff({
      finalRegime,
      standardActiveRegime: resolved.activeRegime,
      shockAActive: nextA.active,
    });
    const us02yRaw = slice(opts.sources.dgs2, addDays(t, -45), t);
    let us02yClose: number | null = null;
    let us02ySma21: number | null = null;
    if (us02yRaw.length > 0) {
      const refCal = generateTradingDays(us02yRaw[0].date, t);
      const clean = buildCleanSeries(us02yRaw, refCal, t, FREDL(cfg));
      us02yClose = clean.isStale || clean.series.length === 0 ? null : clean.series[clean.series.length - 1].value;
      us02ySma21 = clean.isStale ? null : computeUs02ySma(clean.series.map((o) => o.value), cfg.rateGate.rate_gate_sma_window);
    }
    const hawkish = computeRateGateHawkish(us02yClose, us02ySma21);
    const rateGate = evaluateRateGate({
      enabled: cfg.rateGate.rate_gate_enabled,
      regimePathRiskOff,
      rateGateHawkish: hawkish,
      shockBActive: nextB.active,
    });
    const fedGate = evaluateFedConstraintGate({ regimePathRiskOff, fedConstraint: opts.fedConstraint });

    const overrides: string[] = [];
    if (regimePathRiskOff) {
      overrides.push('O1', 'O4');
      if (fedGate.overrideActive) overrides.push('O2');
      if (rateGate.overridesActive) overrides.push('O3', 'O5');
    } else if (nextB.active && rateGate.overridesActive) {
      overrides.push('O3', 'O5');
    }

    rows.push({
      date: ymd(t),
      inWindow: t.getTime() >= opts.from.getTime(),
      vixRaw: v.raw, vix5dAvg: v.avg, vixBand: v.band, vixNote: v.note,
      tsRatio: vts.ratio, vixTsBand: vts.band, vixTsNote: vts.note,
      oasLevel: oas.level, oasDelta10: oas.delta10, oasBand: oas.band, oasNote: oas.note,
      t10y2y, delta30, inversionStart, unInversionDate, insideRedWindow: insideRed,
      realYield60dBp, realYieldBand, curveGreenGated, curveBand, curveNote,
      dxyClose: dxy.close, dxyDev: dxy.dev, dxyMove5: dxy.move5, dxyBand: dxy.band, dxyNote: dxy.note,
      cpiBand: ds.cpiBand, cpiYoY3: fmtArr(ds.yoy3), cpiLatestYoY: ds.latestYoY,
      gdpBand: ds.gdpBand, gdpQoQ2: fmtArr(ds.qoq2),
      jobsBand: ds.jobsBand, jobsNfp3: fmtArr(ds.nfp3, 0), sahmDelta: ds.sahmDelta,
      dataStackBand: ds.overall,
      greenWeight: voteWeights.green, yellowWeight: voteWeights.yellow, redWeight: voteWeights.red,
      candidateRegime, activeRegime: resolved.activeRegime,
      persistenceDaysCount: resolved.persistenceDaysCount,
      usdJpyClose: jpyRow ? jpyRow.value : null,
      triggerAFired: triggerA.fired, triggerBFired: triggerB.fired,
      shockAActive: nextA.active, shockBActive: nextB.active,
      finalRegime,
      us02yClose, us02ySma21, rateGateHawkish: rateGate.hawkishResolved,
      regimePathRiskOff, overridesActive: overrides.join(' '),
    });

    prior = {
      activeRegime: resolved.activeRegime,
      candidateRegime,
      persistenceDaysCount: resolved.persistenceDaysCount,
    };
  }

  return rows;
}

export const REPLAY_HEADER: (keyof ReplayRow)[] = [
  'date', 'inWindow',
  'vixRaw', 'vix5dAvg', 'vixBand', 'vixNote',
  'tsRatio', 'vixTsBand', 'vixTsNote',
  'oasLevel', 'oasDelta10', 'oasBand', 'oasNote',
  't10y2y', 'delta30', 'inversionStart', 'unInversionDate', 'insideRedWindow', 'realYield60dBp', 'realYieldBand', 'curveGreenGated', 'curveBand', 'curveNote',
  'dxyClose', 'dxyDev', 'dxyMove5', 'dxyBand', 'dxyNote',
  'cpiBand', 'cpiYoY3', 'cpiLatestYoY', 'gdpBand', 'gdpQoQ2', 'jobsBand', 'jobsNfp3', 'sahmDelta', 'dataStackBand',
  'greenWeight', 'yellowWeight', 'redWeight',
  'candidateRegime', 'activeRegime', 'persistenceDaysCount',
  'usdJpyClose', 'triggerAFired', 'triggerBFired', 'shockAActive', 'shockBActive', 'finalRegime',
  'us02yClose', 'us02ySma21', 'rateGateHawkish', 'regimePathRiskOff', 'overridesActive',
];

export function rowsToCsv(rows: ReplayRow[]): (string | number | boolean | null)[][] {
  return rows.map((r) => REPLAY_HEADER.map((k) => r[k] as string | number | boolean | null));
}

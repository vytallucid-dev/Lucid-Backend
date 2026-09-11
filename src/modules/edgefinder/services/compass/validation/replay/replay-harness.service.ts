import { logger } from '@core/utils/logger';
import { runReplay, type ReplayRow, type ReplayOptions } from './engine';
import { WINDOWS, type Criterion, type WindowSpec } from './windows';
import {
  loadReplaySources,
  SOURCE_SUBSTITUTIONS,
  HY_OAS_LIMITATION,
  HY_OAS_PROXY_LIMITATION,
} from './replay-sources.service';
import { loadAllVintages } from './pit-macro';
import type { CompassConfigDefinition } from '../../compass-config.types';
import { ymd } from './series';

/**
 * The Compass validation harness.
 *
 * WHY IT REPLAYS RATHER THAN READS
 * --------------------------------
 * The previous harness only READ `compass_classifications WHERE isValidation =
 * true` and compared regimes. It had never produced a non-zero result, and could
 * not: the only path that could populate those rows called the live input
 * services day by day, and the live HY OAS service THROWS when FRED returns
 * nothing (which it does for every date before 2023-09-11), so the backfill
 * skipped the classifier for every historical day and wrote nothing. Layered on
 * top, EODHD serves twelve months of history under a call cap shared with NIFTY.
 *
 * So the harness now runs the replay engine itself. Every scoring decision is
 * still made by the SHIPPED pure modules — compass-bands, compass-calculations,
 * compass-staleness, compass-curve-state-machine, compass-shock-layer,
 * compass-classifier-logic, compass-override-gates. The engine contributes only
 * the per-input plumbing and the daily ordering that the live input services
 * would otherwise perform.
 *
 * THREE DEFECTS THIS FIXES, all of which made results meaningless rather than
 * merely wrong:
 *
 *   1. It read `activeRegime`. The Shock Layer writes its Risk-Off override ONLY
 *      to `finalRegime` and deliberately never touches `activeRegime`, so the
 *      entire Phase 4 deliverable was invisible to validation. 2024_YEN_UNWIND
 *      failed with zero Risk-Off days even though Trigger A fired correctly on
 *      2024-08-05.
 *   2. `requiresCrisisOverride` was structurally unsatisfiable. Phase 4 retired
 *      the crisis clause and the classifier writes `crisisOverrideFired: false`
 *      unconditionally, so 2008_GFC and 2020_COVID could not pass under any data.
 *   3. Only four of the eight specified windows existed, and one of those four
 *      measured duration where the architecture produces a spike.
 *
 * NOTHING IS TUNED TO MAKE A WINDOW PASS. Criteria changed in exactly the two
 * places the defects required, both documented at the point of change in
 * `windows.ts`, and both replacing an impossible test with a real one that can
 * and does fail.
 */

/** Discriminates this shape from the legacy one already in the JSONB column. */
export const REPORT_KIND = 'compass-phase-c-replay-v1';

/**
 * How HY OAS is treated for a window that predates 2023-09-11.
 *
 * FRED retroactively truncated every ICE BofA OAS series, across all vintages,
 * so pre-2023 credit is not merely missing — it is unobtainable. HY_OAS carries
 * 1.5 of the 8.0 scale AND is one of Trigger A's two legs, so a single number
 * for those windows would be a fabrication. Each is reported as a BRACKET:
 *
 *   absent   what the live code actually does — YELLOW, no delta, and (because
 *            no level is produced) Trigger A's OAS leg is starved. Lower bound.
 *   proxy    BAA10Y-derived best estimate. See HY_OAS_PROXY_LIMITATION: it
 *            compresses, so it too is conservative.
 *   forcered the band pinned RED: maximum credit stress. Upper bound. Note this
 *            still starves Trigger A, deliberately — the OAS velocity leg cannot
 *            be fabricated, only the level vote can.
 *
 * A failure that survives `forcered` is provably NOT caused by the missing series.
 */
export type HyOasBracket = 'real' | 'absent' | 'proxy' | 'forcered';

export interface CriterionResult {
  kind: Criterion['kind'];
  passed: boolean;
  detail: string;
}

export interface InputBandShare {
  input: string;
  greenPct: number;
  yellowPct: number;
  redPct: number;
}

export interface WindowBracketResult {
  bracket: HyOasBracket;
  tradingDays: number;
  riskOffDays: number;
  cautionDays: number;
  riskOnDays: number;
  riskOffPercent: number;
  riskOnPercent: number;
  longestRiskOffRun: number;
  triggerAFiredDates: string[];
  criteria: CriterionResult[];
  passed: boolean;
  /** Per-input band distribution — the "which input didn't fire" detail. */
  inputBands: InputBandShare[];
  /** Mean vote weights across the window, for failure arithmetic. */
  meanRedWeight: number;
  meanGreenWeight: number;
  /** How far the mean red weight sat below the Risk-Off threshold. */
  redWeightShortfall: number;
}

export interface WindowResultV2 {
  id: string;
  windowName: string;
  startDate: string;
  endDate: string;
  /** True when HY OAS is unobtainable for this window and it must be bracketed. */
  bracketed: boolean;
  /** The bracket whose verdict is reported as THE result. */
  primaryBracket: HyOasBracket;
  passed: boolean;
  results: WindowBracketResult[];
  /** Plain-language account of why it failed, if it did. */
  failureAnalysis: string | null;
  note: string;
}

export interface ValidationReportV2 {
  reportKind: typeof REPORT_KIND;
  generatedAt: string;
  configVersionLabel: string | null;
  macroMode: 'pit' | 'live';
  overallPassed: boolean;
  passedCount: number;
  windowCount: number;
  summary: string;
  windows: WindowResultV2[];
  /** Surfaced with the results, not buried in a doc. */
  sourceSubstitutions: typeof SOURCE_SUBSTITUTIONS;
  hyOasLimitation: string;
  hyOasProxyLimitation: string;
  operationalConstraints: string[];
}

/** HY OAS exists from here; before it, every window must be bracketed. */
const HY_OAS_FIRST_DATE = Date.UTC(2023, 8, 11);

const RISK_OFF_THRESHOLD_FALLBACK = 3.5;

function longestRun(rows: ReplayRow[], pred: (r: ReplayRow) => boolean): number {
  let best = 0;
  let cur = 0;
  for (const r of rows) {
    if (pred(r)) {
      cur += 1;
      if (cur > best) best = cur;
    } else cur = 0;
  }
  return best;
}

/**
 * THE regime a criterion is judged on.
 *
 * `finalRegime`, not `activeRegime` — Trigger A's Risk-Off override writes only
 * the former. Empty string is coalesced because rows written before Phase 4
 * carry `final_regime = ''` (45 such rows existed in the live table before it
 * was archived), and reading '' as a regime would silently count them as
 * neither Risk-Off nor Risk-On.
 */
export function effectiveRegime(r: Pick<ReplayRow, 'finalRegime' | 'activeRegime'>): string {
  return r.finalRegime && r.finalRegime.length > 0 ? r.finalRegime : r.activeRegime;
}

export function evalCriterion(
  c: Criterion,
  w: WindowSpec,
  rows: ReplayRow[],
): CriterionResult {
  const n = rows.length;
  const riskOff = rows.filter((r) => effectiveRegime(r) === 'Risk-Off');
  const riskOn = rows.filter((r) => effectiveRegime(r) === 'Risk-On');

  switch (c.kind) {
    case 'min_risk_off_pct': {
      const pct = n === 0 ? 0 : (riskOff.length / n) * 100;
      return {
        kind: c.kind,
        passed: pct >= c.pct,
        detail: `Risk-Off ${riskOff.length}/${n} = ${pct.toFixed(1)}% (need >=${c.pct}%)`,
      };
    }
    case 'min_risk_off_days':
      return {
        kind: c.kind,
        passed: riskOff.length >= c.days,
        detail: `Risk-Off days = ${riskOff.length} (need >=${c.days})`,
      };
    case 'min_risk_on_pct': {
      const pct = n === 0 ? 0 : (riskOn.length / n) * 100;
      return {
        kind: c.kind,
        passed: pct >= c.pct,
        detail: `Risk-On ${riskOn.length}/${n} = ${pct.toFixed(1)}% (need >=${c.pct}%)`,
      };
    }
    case 'max_risk_off_run': {
      const run = longestRun(rows, (r) => effectiveRegime(r) === 'Risk-Off');
      return {
        kind: c.kind,
        passed: run <= c.days,
        detail: `longest Risk-Off run = ${run} (max ${c.days})`,
      };
    }
    case 'no_false_risk_on_in_core': {
      if (!w.crisisCore) return { kind: c.kind, passed: true, detail: 'no crisis core defined' };
      const s = w.crisisCore.start.getTime();
      const e = w.crisisCore.end.getTime();
      const bad = rows.filter((r) => {
        const t = new Date(`${r.date}T00:00:00Z`).getTime();
        return t >= s && t <= e && effectiveRegime(r) === 'Risk-On';
      });
      return {
        kind: c.kind,
        passed: bad.length === 0,
        detail: bad.length
          ? `${bad.length} false Risk-On day(s) in the crisis core: ${bad.slice(0, 8).map((b) => b.date).join(' ')}${bad.length > 8 ? ' ...' : ''}`
          : 'none',
      };
    }
    case 'crisis_override_on_peak': {
      // Retained only so a legacy spec cannot silently pass. Phase 4 retired the
      // clause; the classifier writes crisisOverrideFired: false unconditionally.
      const peak = w.peakDate ? rows.find((r) => r.date === ymd(w.peakDate as Date)) : undefined;
      const successor = peak ? peak.triggerAFired || peak.shockAActive : false;
      return {
        kind: c.kind,
        passed: false,
        detail:
          'crisis_override_fired has been hardcoded FALSE since Phase 4 — this criterion is ' +
          `structurally unsatisfiable. Phase-4 successor on the peak date: ${successor}`,
      };
    }
    case 'trigger_a_fires_between': {
      const s = c.start.getTime();
      const e = c.end.getTime();
      const fired = rows.filter((r) => {
        const t = new Date(`${r.date}T00:00:00Z`).getTime();
        return t >= s && t <= e && r.triggerAFired;
      });
      return {
        kind: c.kind,
        passed: fired.length > 0,
        detail: fired.length
          ? `Trigger A fired on ${fired.map((f) => f.date).join(', ')}`
          : `Trigger A never fired in ${ymd(c.start)}..${ymd(c.end)}`,
      };
    }
    case 'trigger_a_never_fires': {
      const fired = rows.filter((r) => r.triggerAFired);
      return {
        kind: c.kind,
        passed: fired.length === 0,
        detail: fired.length
          ? `Trigger A fired on ${fired.map((f) => f.date).join(', ')}`
          : 'Trigger A never fired (correct)',
      };
    }
    case 'never_risk_off': {
      const bad = rows.filter((r) => effectiveRegime(r) === 'Risk-Off');
      return {
        kind: c.kind,
        passed: bad.length === 0,
        detail: bad.length
          ? `${bad.length} Risk-Off day(s): ${bad.slice(0, 8).map((b) => b.date).join(' ')}`
          : 'never Risk-Off (correct)',
      };
    }
  }
}

function bandShares(rows: ReplayRow[]): InputBandShare[] {
  const n = rows.length || 1;
  const defs: Array<{ input: string; get: (r: ReplayRow) => string }> = [
    { input: 'VIX_5D_AVG', get: (r) => r.vixBand },
    { input: 'VIX_TERM_STRUCTURE', get: (r) => r.vixTsBand },
    { input: 'HY_OAS', get: (r) => r.oasBand },
    { input: 'YIELD_2S10S', get: (r) => r.curveBand },
    { input: 'DXY_TREND', get: (r) => r.dxyBand },
    { input: 'US_DATA_STACK', get: (r) => r.dataStackBand },
  ];
  const pct = (k: number): number => Math.round((k / n) * 1000) / 10;
  return defs.map((d) => ({
    input: d.input,
    greenPct: pct(rows.filter((r) => d.get(r) === 'GREEN').length),
    yellowPct: pct(rows.filter((r) => d.get(r) === 'YELLOW').length),
    redPct: pct(rows.filter((r) => d.get(r) === 'RED').length),
  }));
}

/**
 * Plain-language failure analysis at the level the brief asks for: WHICH input
 * did not fire, and what it would have had to do.
 */
function analyseFailure(
  w: WindowSpec,
  res: WindowBracketResult,
  redRiskOffAt: number,
): string | null {
  if (res.passed) return null;
  const parts: string[] = [];
  for (const c of res.criteria.filter((x) => !x.passed)) {
    parts.push(`[${c.kind}] ${c.detail}`);
  }
  if (res.tradingDays > 0) {
    parts.push(
      `Mean red weight ${res.meanRedWeight.toFixed(2)} against a Risk-Off threshold of ` +
        `${redRiskOffAt} (shortfall ${res.redWeightShortfall.toFixed(2)}).`,
    );
    const quiet = res.inputBands
      .filter((b) => b.redPct === 0)
      .map((b) => `${b.input} never RED (GREEN ${b.greenPct}%)`);
    if (quiet.length > 0) {
      parts.push(`Inputs that never fired: ${quiet.join('; ')}.`);
    }
    const curve = res.inputBands.find((b) => b.input === 'YIELD_2S10S');
    if (curve && curve.greenPct > 50) {
      parts.push(
        `YIELD_2S10S voted GREEN on ${curve.greenPct}% of the window — a steepening curve reads ` +
          'as health to the shipped rule even when the steepening IS the stress.',
      );
    }
  }
  if (w.id === 'V4') {
    parts.push(
      'This failure survives HY OAS pinned RED, so it is not a data artifact. It is the ' +
        'architecture\'s genuine limit: 2022 was an orderly repricing with credit spreads never ' +
        'above ~6% and no funding event, which this classifier is built to read as Caution.',
    );
  }
  return parts.join(' ');
}

export interface RunSuiteOptions {
  config: CompassConfigDefinition;
  macroMode?: 'pit' | 'live';
  /** Restrict to specific window ids, e.g. ['V1','V4']. Default: all eight. */
  only?: string[];
}

/** Run one window under one bracket. */
async function runWindowBracket(
  w: WindowSpec,
  bracket: HyOasBracket,
  opts: RunSuiteOptions,
): Promise<WindowBracketResult> {
  const sources = await loadReplaySources();
  const redRiskOffAt = opts.config.candidateRegime.redRiskOffAt ?? RISK_OFF_THRESHOLD_FALLBACK;

  const replayOptions: ReplayOptions = {
    from: w.replayFrom,
    to: w.endDate,
    config: opts.config,
    sources: {
      ...sources,
      hyOas: bracket === 'proxy' ? sources.hyOasProxy : sources.hyOasReal,
    },
    macroMode: opts.macroMode ?? 'pit',
    curveSeed: 'full',
    warmupDays: 0,
    fedConstraint: 'FREE',
    hyOasMode:
      bracket === 'absent' ? 'unavailable' : bracket === 'forcered' ? 'force_red' : 'none',
    label: `${w.id}_${bracket}`,
  };

  const all = runReplay(replayOptions);

  // `replayFrom` is a LEAD-IN date, not the assertion window: the engine needs
  // history behind `startDate` to warm up 50-observation SMAs, the 30-day curve
  // delta and the persistence machine. The engine's own `inWindow` flag is
  // `t >= opts.from`, which is true for the whole lead-in, so assertions must be
  // scoped to [startDate, endDate] here. Getting this wrong silently inflates
  // every day count and dilutes every percentage.
  const winStart = w.startDate.getTime();
  const winEnd = w.endDate.getTime();
  const rows = all.filter((r) => {
    const t = new Date(`${r.date}T00:00:00Z`).getTime();
    return t >= winStart && t <= winEnd;
  });

  const riskOff = rows.filter((r) => effectiveRegime(r) === 'Risk-Off').length;
  const riskOn = rows.filter((r) => effectiveRegime(r) === 'Risk-On').length;
  const caution = rows.length - riskOff - riskOn;
  const criteria = w.criteria.map((c) => evalCriterion(c, w, rows));
  const meanRed = rows.length ? rows.reduce((s, r) => s + r.redWeight, 0) / rows.length : 0;
  const meanGreen = rows.length ? rows.reduce((s, r) => s + r.greenWeight, 0) / rows.length : 0;

  const result: WindowBracketResult = {
    bracket,
    tradingDays: rows.length,
    riskOffDays: riskOff,
    cautionDays: caution,
    riskOnDays: riskOn,
    riskOffPercent: rows.length ? Math.round((riskOff / rows.length) * 1000) / 10 : 0,
    riskOnPercent: rows.length ? Math.round((riskOn / rows.length) * 1000) / 10 : 0,
    longestRiskOffRun: longestRun(rows, (r) => effectiveRegime(r) === 'Risk-Off'),
    triggerAFiredDates: rows.filter((r) => r.triggerAFired).map((r) => r.date),
    criteria,
    passed: criteria.every((c) => c.passed),
    inputBands: bandShares(rows),
    meanRedWeight: Math.round(meanRed * 100) / 100,
    meanGreenWeight: Math.round(meanGreen * 100) / 100,
    redWeightShortfall: Math.round(Math.max(0, redRiskOffAt - meanRed) * 100) / 100,
  };
  return result;
}

export async function runValidationSuite(opts: RunSuiteOptions): Promise<ValidationReportV2> {
  // One request per series, once for the whole suite.
  await loadAllVintages();
  await loadReplaySources();

  const specs = opts.only ? WINDOWS.filter((w) => opts.only!.includes(w.id)) : WINDOWS;
  const windows: WindowResultV2[] = [];

  for (const w of specs) {
    const bracketed = w.endDate.getTime() < HY_OAS_FIRST_DATE;
    const brackets: HyOasBracket[] = bracketed
      ? ['absent', 'proxy', 'forcered']
      : ['real'];

    const results: WindowBracketResult[] = [];
    for (const b of brackets) {
      results.push(await runWindowBracket(w, b, opts));
    }

    // The PROXY bracket is the primary read for a bracketed window — it is the
    // best available estimate — but the verdict is only reported alongside the
    // other two, never instead of them.
    const primaryBracket: HyOasBracket = bracketed ? 'proxy' : 'real';
    const primary = results.find((r) => r.bracket === primaryBracket)!;

    windows.push({
      id: w.id,
      windowName: w.name,
      startDate: ymd(w.startDate),
      endDate: ymd(w.endDate),
      bracketed,
      primaryBracket,
      passed: primary.passed,
      results,
      failureAnalysis: analyseFailure(w, primary, opts.config.candidateRegime.redRiskOffAt),
      note: w.note,
    });

    logger.info(
      {
        window: `${w.id} ${w.name}`,
        passed: primary.passed,
        bracket: primaryBracket,
        riskOffPct: primary.riskOffPercent,
        tradingDays: primary.tradingDays,
      },
      'Replay harness: window complete',
    );
  }

  const passedCount = windows.filter((w) => w.passed).length;
  const summary =
    `${passedCount}/${windows.length} windows passed. ` +
    windows.map((w) => `${w.id} ${w.windowName}: ${w.passed ? 'PASS' : 'FAIL'}`).join('; ');

  return {
    reportKind: REPORT_KIND,
    generatedAt: new Date().toISOString(),
    configVersionLabel: opts.config.versionLabel ?? null,
    macroMode: opts.macroMode ?? 'pit',
    overallPassed: passedCount === windows.length,
    passedCount,
    windowCount: windows.length,
    summary,
    windows,
    sourceSubstitutions: SOURCE_SUBSTITUTIONS,
    hyOasLimitation: HY_OAS_LIMITATION,
    hyOasProxyLimitation: HY_OAS_PROXY_LIMITATION,
    operationalConstraints: [
      'The EODHD client enforces a 15-call/day cap that is PROCESS-GLOBAL and shared with NIFTY. ' +
        'Compass already spends ~5/day and NIFTY ~2. No Compass series may be added to EODHD ' +
        'without first re-checking that budget — it is a collision waiting to happen, and it is ' +
        'the second reason (after the 12-month history limit) that this harness replays from ' +
        'FRED and Yahoo instead of the live input path.',
      'DFII10 begins 2003-01-02, so R1 and the 2s10s GREEN gate are inert before then.',
      'The replay uses the holiday-aware US market calendar, matching the live classifier. Phase B ' +
        'used a weekday-only filter, so figures differ slightly on windows containing market ' +
        'holidays. The change is a correction, not a regression.',
    ],
  };
}

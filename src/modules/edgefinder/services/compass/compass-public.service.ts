import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import {
  compassClassificationsRepository,
  type CompassClassificationRow,
} from '@core/repositories/compass-classifications.repository';
import { compassShockStateRepository } from '@core/repositories/compass-shock-state.repository';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import type { Regime } from './compass-classifier-logic';
import type { ColorBand } from './compass-bands';

/** Regime severity ordering — mirrors compass-classifier-logic.ts. Higher = more severe. */
const REGIME_SEVERITY: Record<Regime, number> = { 'Risk-On': 0, Caution: 1, 'Risk-Off': 2 };

// ─────────────────────────────────────────────────────────────────────────────
// Public Compass snapshot — assembles everything the Compass page needs in ONE
// response from ~4 indexed, parallel queries. The data changes once per day
// (classifier cron), so it is identical for every user and safe to cache hard.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical input order shown on the page. */
const INPUT_ORDER = [
  'VIX_5D_AVG',
  'HY_OAS',
  'YIELD_2S10S',
  'DXY_TREND',
  'VIX_TERM_STRUCTURE',
  'US_DATA_STACK',
] as const;

const HISTORY_DAYS = 30;

export interface CompassSubCheck {
  name: string;
  value: string;
  detail: string;
  colorBand: ColorBand;
}

export interface CompassInputVote {
  code: string;
  colorBand: ColorBand;
  weight: number;
  displayValue: string;
  displayDetail: string | null;
  subChecks: CompassSubCheck[] | null;
  /** Phase 5: the input's own row was flagged stale beyond its limit at ingest. */
  stale: boolean;
  /** Phase 5: not enough clean history for the input's lookback. */
  insufficientHistory: boolean;
}

/** Phase 6 per-override active/suppressed state + human reason. */
export interface CompassOverrideState {
  code: string;
  /** 1..5 */
  id: number;
  active: boolean;
  suppressed: boolean;
  /** Short reason string when suppressed/blocked, else null. */
  reason: string | null;
}

/** Phase 6 gate + shock state for the current day. */
export interface CompassGateState {
  finalRegime: Regime;
  shockAActive: boolean;
  shockAExpiry: string | null;
  shockBActive: boolean;
  shockBExpiry: string | null;
  rateGateHawkish: boolean;
  us02yClose: number | null;
  us02ySma21: number | null;
  override3SuppressedByGate: boolean;
  override5SuppressedByGate: boolean;
  fedConstraint: string;
  fedConstraintEffectiveFrom: string | null;
  override2SuppressedByConstraint: boolean;
  overridesActive: string[];
  overrides: CompassOverrideState[];
}

export interface CompassOverrideRef {
  code: string;
  adjustment: number;
}

export interface CompassScoreImpactRow {
  asset: string;
  kind: 'asset' | 'pair';
  baseScore: number;
  finalScore: number;
  adjustment: number;
  regime: Regime | null;
  overrides: CompassOverrideRef[];
}

export interface CompassHistoryRow {
  date: string;
  /** The FINAL regime for the day (Risk-Off under a Trigger A shock), for accurate history. */
  finalRegime: Regime;
  /** The standard machine's regime (unchanged by shocks). */
  activeRegime: Regime;
  candidateRegime: Regime;
  shockAActive: boolean;
  shockBActive: boolean;
  greenWeight: number;
  redWeight: number;
  bands: Record<string, ColorBand>;
}

/** Config-driven regime thresholds in force, for the UI to show the rule. */
export interface CompassThresholds {
  redRiskOffAt: number;
  greenRiskOnAt: number;
  redRiskOnCeiling: number;
  daysToHigherSeverity: number;
  daysToLowerSeverity: number;
}

export interface CompassSnapshot {
  current: {
    classificationDate: string;
    candidateRegime: Regime;
    /** Standard machine active regime (== standard_active_regime). */
    activeRegime: Regime;
    /** Phase 4: the ACTUAL regime — Risk-Off under a Trigger A shock. The UI shows THIS. */
    finalRegime: Regime;
    persistenceDaysCount: number;
    /** Phase 3 persistence: the pending candidate label building toward a flip, or null. */
    pendingLabel: Regime | null;
    /** Days confirmed toward the pending flip (== persistenceDaysCount when pending). */
    pendingCount: number;
    /** Days required for the pending flip (3 toward higher severity, 5 toward lower). */
    required: number;
    daysStable: number;
    weights: { green: number; yellow: number; red: number; total: number };
    thresholds: CompassThresholds;
  };
  gate: CompassGateState;
  inputs: CompassInputVote[];
  scoreImpact: CompassScoreImpactRow[];
  history: CompassHistoryRow[];
}

// ─── JSON narrowing helpers (no `any`) ───────────────────────────────────────

type JsonObject = Record<string, Prisma.JsonValue>;

function asObject(j: Prisma.JsonValue | null | undefined): JsonObject | null {
  if (j !== null && j !== undefined && typeof j === 'object' && !Array.isArray(j)) {
    return j as JsonObject;
  }
  return null;
}

function asNumberArray(j: Prisma.JsonValue | undefined): number[] {
  if (Array.isArray(j)) return j.filter((v): v is number => typeof v === 'number');
  return [];
}

function asBand(j: Prisma.JsonValue | undefined): ColorBand {
  return j === 'GREEN' || j === 'RED' ? j : 'YELLOW';
}

function toNum(d: Prisma.Decimal | null): number | null {
  return d === null ? null : Number(d.toString());
}

// ─── Per-input display formatting (owns the domain units/semantics) ──────────

interface RawInputRow {
  inputCode: string;
  rawValue: number | null;
  derivedValue: number | null;
  subChecks: Prisma.JsonValue | null;
}

function formatStackSubChecks(subChecks: Prisma.JsonValue | null): CompassSubCheck[] {
  const s = asObject(subChecks);
  if (!s) return [];
  const out: CompassSubCheck[] = [];

  const cpi = asObject(s.cpi);
  if (cpi) {
    const band = asBand(cpi.band);
    const yoy = asNumberArray(cpi.recentYoY);
    out.push({
      name: 'CPI Trajectory',
      value: yoy.length ? yoy.map((v) => `${v.toFixed(1)}%`).join(' → ') : '—',
      detail:
        band === 'GREEN' ? 'Falling — disinflation' : band === 'RED' ? 'Rising 3-in-a-row' : 'Mixed (not 3-in-a-row)',
      colorBand: band,
    });
  }

  const gdp = asObject(s.gdp);
  if (gdp) {
    const band = asBand(gdp.band);
    const qoq = asNumberArray(gdp.recentQoQ);
    out.push({
      name: 'GDP Level',
      value: qoq.length ? qoq.map((v) => `${v.toFixed(1)}%`).join(' · ') : '—',
      detail: band === 'GREEN' ? 'Both > 1.5%' : band === 'RED' ? 'Contraction' : 'Below trend',
      colorBand: band,
    });
  }

  const jobs = asObject(s.jobs);
  if (jobs) {
    const band = asBand(jobs.band);
    const sahm = asObject(jobs.sahm);
    const delta = sahm && typeof sahm.delta === 'number' ? sahm.delta : null;
    out.push({
      name: 'Jobs (Sahm Rule)',
      value: delta !== null ? `Δ from 12mo low: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}pp` : '—',
      detail:
        band === 'RED' ? 'Sahm triggered / weak NFP' : band === 'GREEN' ? 'Below 0.5pp threshold' : 'Near 0.5pp threshold',
      colorBand: band,
    });
  }

  return out;
}

function formatInputDisplay(row: RawInputRow | undefined): {
  displayValue: string;
  displayDetail: string | null;
  subChecks: CompassSubCheck[] | null;
} {
  const raw = row?.rawValue ?? null;
  const derived = row?.derivedValue ?? null;

  switch (row?.inputCode) {
    case 'VIX_5D_AVG':
      return { displayValue: derived !== null ? derived.toFixed(1) : '—', displayDetail: null, subChecks: null };

    case 'HY_OAS':
      return {
        displayValue: raw !== null ? `${Math.round(raw * 100)}bp` : '—',
        displayDetail:
          derived === null ? null : derived > 0 ? `+${Math.round(derived * 100)}bp (10obs)` : `${Math.round(derived * 100)}bp (10obs)`,
        subChecks: null,
      };

    case 'YIELD_2S10S':
      return {
        displayValue: raw !== null ? `${raw >= 0 ? '+' : ''}${raw.toFixed(2)}%` : '—',
        displayDetail:
          raw === null
            ? null
            : raw < 0
              ? 'Inverted'
              : derived !== null && derived > 0
                ? 'Steepening'
                : derived !== null && derived < 0
                  ? 'Flattening'
                  : 'Stable',
        subChecks: null,
      };

    case 'DXY_TREND':
      return {
        displayValue: derived !== null ? `${(derived * 100).toFixed(1)}% from 50d MA` : '—',
        displayDetail: null,
        subChecks: null,
      };

    case 'VIX_TERM_STRUCTURE':
      return { displayValue: raw !== null ? raw.toFixed(3) : '—', displayDetail: null, subChecks: null };

    case 'US_DATA_STACK': {
      const subChecks = formatStackSubChecks(row?.subChecks ?? null);
      const greens = subChecks.filter((c) => c.colorBand === 'GREEN').length;
      return { displayValue: `${greens} of 3 sub-checks Green`, displayDetail: null, subChecks };
    }

    default:
      return { displayValue: '—', displayDetail: null, subChecks: null };
  }
}

// ─── voteBreakdown + overrides JSON parsing ──────────────────────────────────

function bandsFromVoteBreakdown(voteBreakdown: Prisma.JsonValue): Record<string, ColorBand> {
  const root = asObject(voteBreakdown);
  const inputs = root ? asObject(root.inputs) : null;
  const bands: Record<string, ColorBand> = {};
  if (inputs) {
    for (const code of INPUT_ORDER) {
      const entry = asObject(inputs[code]);
      if (entry) bands[code] = asBand(entry.colorBand);
    }
  }
  return bands;
}

function weightsFromVoteBreakdown(voteBreakdown: Prisma.JsonValue): Record<string, number> {
  const root = asObject(voteBreakdown);
  const inputs = root ? asObject(root.inputs) : null;
  const weights: Record<string, number> = {};
  if (inputs) {
    for (const code of INPUT_ORDER) {
      const entry = asObject(inputs[code]);
      const w = entry && typeof entry.weight === 'number' ? entry.weight : 0;
      weights[code] = w;
    }
  }
  return weights;
}

function parseOverrides(j: Prisma.JsonValue | null): CompassOverrideRef[] {
  const root = asObject(j);
  if (!root || !Array.isArray(root.overridesFired)) return [];
  const out: CompassOverrideRef[] = [];
  for (const item of root.overridesFired) {
    const entry = asObject(item);
    if (entry && typeof entry.code === 'string' && typeof entry.adjustment === 'number') {
      out.push({ code: entry.code, adjustment: entry.adjustment });
    }
  }
  return out;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function asRegimeOrNull(s: string | null): Regime | null {
  return s === 'Risk-On' || s === 'Caution' || s === 'Risk-Off' ? s : null;
}

// ─── Assembly ────────────────────────────────────────────────────────────────

async function buildScoreImpact(): Promise<CompassScoreImpactRow[]> {
  // Latest current-vintage row per asset / per pair via Postgres DISTINCT ON
  // (Prisma `distinct` + leading orderBy). Both tables index (id, isCurrent,
  // date desc), so each is a cheap indexed scan.
  const [scorecards, pairScores] = await Promise.all([
    prisma.edgefinderScorecard.findMany({
      where: { isCurrent: true },
      orderBy: [{ assetId: 'asc' }, { observationDate: 'desc' }],
      distinct: ['assetId'],
      select: {
        baseFundamentalsScore: true,
        cotScore: true,
        totalScore: true,
        compassAdjustment: true,
        compassOverridesApplied: true,
        regimeAtCompute: true,
        asset: { select: { code: true } },
      },
    }),
    prisma.edgefinderPairScore.findMany({
      where: { isCurrent: true },
      orderBy: [{ pairId: 'asc' }, { scoreDate: 'desc' }],
      distinct: ['pairId'],
      select: {
        baseTotal: true,
        totalScore: true,
        compassAdjustment: true,
        compassOverridesApplied: true,
        regimeAtCompute: true,
        pair: { select: { code: true } },
      },
    }),
  ]);

  const assetRows: CompassScoreImpactRow[] = scorecards.map((s) => ({
    asset: s.asset.code,
    kind: 'asset',
    baseScore: s.baseFundamentalsScore + s.cotScore,
    finalScore: s.totalScore,
    adjustment: s.compassAdjustment,
    regime: asRegimeOrNull(s.regimeAtCompute),
    overrides: parseOverrides(s.compassOverridesApplied),
  }));

  const pairRows: CompassScoreImpactRow[] = pairScores.map((p) => ({
    asset: p.pair.code,
    kind: 'pair',
    baseScore: p.baseTotal,
    finalScore: p.totalScore,
    adjustment: p.compassAdjustment,
    regime: asRegimeOrNull(p.regimeAtCompute),
    overrides: parseOverrides(p.compassOverridesApplied),
  }));

  return [...pairRows, ...assetRows];
}

function buildHistory(rows: CompassClassificationRow[]): CompassHistoryRow[] {
  return rows.map((r) => ({
    date: toIsoDate(r.classificationDate),
    finalRegime: (r.finalRegime || r.activeRegime) as Regime,
    activeRegime: r.activeRegime,
    candidateRegime: r.candidateRegime,
    shockAActive: r.shockAActive,
    shockBActive: r.shockBActive,
    greenWeight: r.totalGreenWeight,
    redWeight: r.totalRedWeight,
    bands: bandsFromVoteBreakdown(r.voteBreakdown),
  }));
}

/** Read `stale` / `insufficientHistory` flags off a stored input row's subChecks. */
function inputFlags(subChecks: Prisma.JsonValue | null): { stale: boolean; insufficientHistory: boolean } {
  const s = asObject(subChecks);
  return {
    stale: s?.stale === true,
    insufficientHistory: s?.insufficientHistory === true,
  };
}

const OVERRIDE_CODE_TO_ID: Record<string, number> = {
  OVERRIDE_1_BAD_NEWS_GOOD_NEWS: 1,
  OVERRIDE_2_GOLD_INFLATION_HEDGE: 2,
  OVERRIDE_3_JPY_SAFE_HAVEN: 3,
  OVERRIDE_4_USD_WEAK_JOBS: 4,
  OVERRIDE_5_CARRY_UNWIND: 5,
};

/**
 * Per-override active/suppressed state for the current day, derived from the
 * classifier's persisted gate decisions. `overridesActive` is the post-gate
 * set that fired; the suppressed flags explain the ones that didn't.
 */
function buildOverrideStates(row: CompassClassificationRow, regimePathRiskOff: boolean): CompassOverrideState[] {
  const active = new Set(
    Array.isArray(row.overridesActive)
      ? (row.overridesActive as Prisma.JsonArray).filter((v): v is string => typeof v === 'string')
      : [],
  );
  const mk = (code: string, suppressed: boolean, reason: string | null): CompassOverrideState => ({
    code,
    id: OVERRIDE_CODE_TO_ID[code],
    active: active.has(code),
    suppressed,
    reason: active.has(code) ? null : suppressed ? reason : regimePathRiskOff ? null : 'Regime path not Risk-Off',
  });
  return [
    mk('OVERRIDE_1_BAD_NEWS_GOOD_NEWS', false, null),
    mk('OVERRIDE_2_GOLD_INFLATION_HEDGE', row.override2SuppressedByConstraint, 'Fed FREE — classical inflation rules apply'),
    mk('OVERRIDE_3_JPY_SAFE_HAVEN', row.override3SuppressedByGate, 'US2Y above 21d SMA — rate differential widening'),
    mk('OVERRIDE_4_USD_WEAK_JOBS', false, null),
    mk('OVERRIDE_5_CARRY_UNWIND', row.override5SuppressedByGate, 'US2Y above 21d SMA — rate differential widening'),
  ];
}

/**
 * Assemble the full Compass snapshot. Returns null when the classifier has not
 * yet produced any classification (fresh DB / before first cron run).
 */
export async function getCompassSnapshot(): Promise<CompassSnapshot | null> {
  const latest = await compassClassificationsRepository.getLatest();
  if (!latest) return null;

  const [inputRows, recent, scoreImpact, shockState, config] = await Promise.all([
    prisma.compassInput.findMany({
      where: { observationDate: latest.classificationDate, isValidation: false },
      select: { inputCode: true, rawValue: true, derivedValue: true, subChecks: true, colorBand: true },
    }),
    compassClassificationsRepository.getRecent(HISTORY_DAYS),
    buildScoreImpact(),
    compassShockStateRepository.get(false),
    compassConfigRepository.resolveForDate(latest.classificationDate),
  ]);

  // Map input rows by code, coercing Decimals once.
  const inputsByCode = new Map<string, RawInputRow & { subChecksRaw: Prisma.JsonValue | null }>();
  for (const r of inputRows) {
    inputsByCode.set(r.inputCode, {
      inputCode: r.inputCode,
      rawValue: toNum(r.rawValue),
      derivedValue: toNum(r.derivedValue),
      subChecks: r.subChecks,
      subChecksRaw: r.subChecks,
    });
  }

  const bands = bandsFromVoteBreakdown(latest.voteBreakdown);
  const weights = weightsFromVoteBreakdown(latest.voteBreakdown);

  const inputs: CompassInputVote[] = INPUT_ORDER.map((code) => {
    const row = inputsByCode.get(code);
    const display = formatInputDisplay(row);
    const flags = inputFlags(row?.subChecksRaw ?? null);
    return {
      code,
      colorBand: bands[code] ?? 'YELLOW',
      weight: weights[code] ?? 0,
      displayValue: display.displayValue,
      displayDetail: display.displayDetail,
      subChecks: display.subChecks,
      stale: flags.stale,
      insufficientHistory: flags.insufficientHistory,
    };
  });

  const history = buildHistory(recent);

  const finalRegime = (latest.finalRegime || latest.activeRegime) as Regime;

  // Days the FINAL regime has held = leading run of same-final-regime history
  // rows (history is newest-first; row 0 is `latest`).
  let daysStable = 0;
  for (const h of history) {
    if (h.finalRegime === finalRegime) daysStable += 1;
    else break;
  }

  const green = latest.totalGreenWeight;
  const yellow = latest.totalYellowWeight;
  const red = latest.totalRedWeight;

  // Pending flip state (Phase 3 asymmetric persistence). A pending streak
  // exists when persistenceDaysCount > 0; the pending label is the candidate
  // that's building, and `required` is 3 toward higher severity else 5.
  const pending = latest.persistenceDaysCount > 0;
  const pendingLabel: Regime | null = pending ? latest.candidateRegime : null;
  const required =
    pendingLabel !== null && REGIME_SEVERITY[pendingLabel] > REGIME_SEVERITY[latest.activeRegime]
      ? config.persistence.daysToHigherSeverity
      : config.persistence.daysToLowerSeverity;

  // regime_path_riskoff (mirrors compass-override-gates.ts) — drives the
  // per-override "inactive vs suppressed" reasons.
  const regimePathRiskOff =
    finalRegime === 'Risk-Off' && (latest.shockAActive || latest.activeRegime === 'Risk-Off');

  const gate: CompassGateState = {
    finalRegime,
    shockAActive: latest.shockAActive,
    shockAExpiry: shockState?.shockAExpiry ? toIsoDate(shockState.shockAExpiry) : null,
    shockBActive: latest.shockBActive,
    shockBExpiry: shockState?.shockBExpiry ? toIsoDate(shockState.shockBExpiry) : null,
    rateGateHawkish: latest.rateGateHawkish,
    us02yClose: latest.us02yClose,
    us02ySma21: latest.us02ySma21,
    override3SuppressedByGate: latest.override3SuppressedByGate,
    override5SuppressedByGate: latest.override5SuppressedByGate,
    fedConstraint: latest.fedConstraint || 'FREE',
    fedConstraintEffectiveFrom: null, // resolved below
    override2SuppressedByConstraint: latest.override2SuppressedByConstraint,
    overridesActive: Array.isArray(latest.overridesActive)
      ? (latest.overridesActive as Prisma.JsonArray).filter((v): v is string => typeof v === 'string')
      : [],
    overrides: buildOverrideStates(latest, regimePathRiskOff),
  };

  // Fed constraint effective-from (display only) — the USD cycle-stance row in
  // force as of the classification date.
  const fedRow = await prisma.currencyCycleStance.findFirst({
    where: {
      currencyCode: 'USD',
      effectiveFrom: { lte: latest.classificationDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: latest.classificationDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { effectiveFrom: true },
  });
  gate.fedConstraintEffectiveFrom = fedRow ? toIsoDate(fedRow.effectiveFrom) : null;

  return {
    current: {
      classificationDate: toIsoDate(latest.classificationDate),
      candidateRegime: latest.candidateRegime,
      activeRegime: latest.activeRegime,
      finalRegime,
      persistenceDaysCount: latest.persistenceDaysCount,
      pendingLabel,
      pendingCount: latest.persistenceDaysCount,
      required,
      daysStable,
      weights: { green, yellow, red, total: green + yellow + red },
      thresholds: {
        redRiskOffAt: config.candidateRegime.redRiskOffAt,
        greenRiskOnAt: config.candidateRegime.greenRiskOnAt,
        redRiskOnCeiling: config.candidateRegime.redRiskOnCeiling,
        daysToHigherSeverity: config.persistence.daysToHigherSeverity,
        daysToLowerSeverity: config.persistence.daysToLowerSeverity,
      },
    },
    gate,
    inputs,
    scoreImpact,
    history,
  };
}

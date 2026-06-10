import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import {
  compassClassificationsRepository,
  type CompassClassificationRow,
} from '@core/repositories/compass-classifications.repository';
import type { Regime } from './compass-classifier-logic';
import type { ColorBand } from './compass-bands';

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
  'GOLD_DXY_CORR',
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
  activeRegime: Regime;
  candidateRegime: Regime;
  crisisOverrideFired: boolean;
  greenWeight: number;
  redWeight: number;
  bands: Record<string, ColorBand>;
}

export interface CompassSnapshot {
  current: {
    classificationDate: string;
    candidateRegime: Regime;
    activeRegime: Regime;
    persistenceDaysCount: number;
    crisisOverrideFired: boolean;
    daysStable: number;
    weights: { green: number; yellow: number; red: number; total: number };
  };
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
        displayDetail: derived === null ? null : derived < 0 ? 'Tightening' : derived > 0 ? 'Widening' : 'Flat',
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
        displayValue: derived !== null ? `${derived >= 0 ? '+' : ''}${derived.toFixed(1)}% from 50d MA` : '—',
        displayDetail: null,
        subChecks: null,
      };

    case 'GOLD_DXY_CORR':
      return { displayValue: raw !== null ? raw.toFixed(2) : '—', displayDetail: null, subChecks: null };

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
    activeRegime: r.activeRegime,
    candidateRegime: r.candidateRegime,
    crisisOverrideFired: r.crisisOverrideFired,
    greenWeight: r.totalGreenWeight,
    redWeight: r.totalRedWeight,
    bands: bandsFromVoteBreakdown(r.voteBreakdown),
  }));
}

/**
 * Assemble the full Compass snapshot. Returns null when the classifier has not
 * yet produced any classification (fresh DB / before first cron run).
 */
export async function getCompassSnapshot(): Promise<CompassSnapshot | null> {
  const latest = await compassClassificationsRepository.getLatest();
  if (!latest) return null;

  const [inputRows, recent, scoreImpact] = await Promise.all([
    prisma.compassInput.findMany({
      where: { observationDate: latest.classificationDate, isValidation: false },
      select: { inputCode: true, rawValue: true, derivedValue: true, subChecks: true },
    }),
    compassClassificationsRepository.getRecent(HISTORY_DAYS),
    buildScoreImpact(),
  ]);

  // Map input rows by code, coercing Decimals once.
  const inputsByCode = new Map<string, RawInputRow>();
  for (const r of inputRows) {
    inputsByCode.set(r.inputCode, {
      inputCode: r.inputCode,
      rawValue: toNum(r.rawValue),
      derivedValue: toNum(r.derivedValue),
      subChecks: r.subChecks,
    });
  }

  const bands = bandsFromVoteBreakdown(latest.voteBreakdown);
  const weights = weightsFromVoteBreakdown(latest.voteBreakdown);

  const inputs: CompassInputVote[] = INPUT_ORDER.map((code) => {
    const display = formatInputDisplay(inputsByCode.get(code));
    return {
      code,
      colorBand: bands[code] ?? 'YELLOW',
      weight: weights[code] ?? 0,
      displayValue: display.displayValue,
      displayDetail: display.displayDetail,
      subChecks: display.subChecks,
    };
  });

  const history = buildHistory(recent);

  // Days the active regime has held = leading run of same-regime history rows
  // (history is newest-first; row 0 is `latest`).
  let daysStable = 0;
  for (const h of history) {
    if (h.activeRegime === latest.activeRegime) daysStable += 1;
    else break;
  }

  const green = latest.totalGreenWeight;
  const yellow = latest.totalYellowWeight;
  const red = latest.totalRedWeight;

  return {
    current: {
      classificationDate: toIsoDate(latest.classificationDate),
      candidateRegime: latest.candidateRegime,
      activeRegime: latest.activeRegime,
      persistenceDaysCount: latest.persistenceDaysCount,
      crisisOverrideFired: latest.crisisOverrideFired,
      daysStable,
      weights: { green, yellow, red, total: green + yellow + red },
    },
    inputs,
    scoreImpact,
    history,
  };
}

import { prisma } from '@core/db/prisma';
import type {
  Ind9Category,
  Ind9Cadence,
  Ind9Cluster,
  Ind9CompositionFlag,
  Ind9SubScore,
  UsdLabComposition,
  UsdLabDataQuality,
  UsdLabFlagCheck,
  UsdLabHistoryPoint,
  UsdLabResponse,
  UsdLabReleaseRow,
  UsdLabSubIndicator,
  UsdLabSubIndicatorDetail,
  UsdLabTier,
} from '../api/usd-lab.types';

const IND9_CODE = 'IND_NIFTY_09_USD_WEAKNESS';
const HISTORY_DEPTH = 30;
const ABSOLUTE_THRESHOLD = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Static config — the 14 sub-indicators in display order (id 1..14).
// cluster + category are fixed by the Ind 9 methodology (Architecture §2.9);
// scoringCategory mirrors the ind9 bridge so reasoning/score reconstruct exactly.
// ─────────────────────────────────────────────────────────────────────────────

type ScoringCategory =
  | 'absolute_threshold'
  | 'vs_forecast'
  | 'direction_vs_prior'
  | 'inverted_vs_prior'
  | 'sma_direction';

interface SubDef {
  id: number;
  code: string;
  name: string;
  short: string;
  cluster: Ind9Cluster;
  category: Ind9Category;
  scoringCategory: ScoringCategory;
}

const SUB_DEFS: SubDef[] = [
  { id: 1,  code: 'US_GDP_QOQ',       name: 'GDP QoQ',                short: 'GDP',     cluster: 'GROWTH',    category: 'vs Forecast',                  scoringCategory: 'vs_forecast' },
  { id: 2,  code: 'US_ISM_MFG',       name: 'ISM Manufacturing PMI', short: 'ISM Mfg', cluster: 'GROWTH',    category: 'Absolute Threshold',           scoringCategory: 'absolute_threshold' },
  { id: 3,  code: 'US_ISM_SVC',       name: 'ISM Services PMI',      short: 'ISM Svc', cluster: 'GROWTH',    category: 'Absolute Threshold',           scoringCategory: 'absolute_threshold' },
  { id: 4,  code: 'US_RETAIL_MOM',    name: 'Retail Sales MoM',      short: 'Retail',  cluster: 'GROWTH',    category: 'vs Forecast',                  scoringCategory: 'vs_forecast' },
  { id: 5,  code: 'US_CB_CONSCONF',   name: 'Consumer Confidence',   short: 'Conf',    cluster: 'SENTIMENT', category: 'vs Forecast',                  scoringCategory: 'vs_forecast' },
  { id: 6,  code: 'US_CPI_YOY',       name: 'CPI YoY',               short: 'CPI',     cluster: 'INFLATION', category: 'Direction vs Prior',           scoringCategory: 'direction_vs_prior' },
  { id: 7,  code: 'US_PPI_MOM',       name: 'PPI MoM',               short: 'PPI',     cluster: 'INFLATION', category: 'Direction vs Prior',           scoringCategory: 'direction_vs_prior' },
  { id: 8,  code: 'US_PCE_YOY',       name: 'Core PCE YoY',          short: 'PCE',     cluster: 'INFLATION', category: 'Direction vs Prior',           scoringCategory: 'direction_vs_prior' },
  { id: 9,  code: 'US_02Y_SMA',       name: 'US 2Y Yield SMA',       short: 'US2Y',    cluster: 'SENTIMENT', category: 'SMA Direction',                scoringCategory: 'sma_direction' },
  { id: 10, code: 'US_NFP',           name: 'Non-Farm Payroll',      short: 'NFP',     cluster: 'LABOR',     category: 'vs Forecast',                  scoringCategory: 'vs_forecast' },
  { id: 11, code: 'US_UNEMP',         name: 'Unemployment Rate',     short: 'Unemp',   cluster: 'LABOR',     category: 'Direction vs Prior (INVERTED)', scoringCategory: 'inverted_vs_prior' },
  { id: 12, code: 'US_JOBLESS_CLAIMS', name: 'Jobless Claims',       short: 'Claims',  cluster: 'LABOR',     category: 'Direction vs Prior (INVERTED)', scoringCategory: 'inverted_vs_prior' },
  { id: 13, code: 'US_ADP',           name: 'ADP Employment',        short: 'ADP',     cluster: 'LABOR',     category: 'vs Forecast',                  scoringCategory: 'vs_forecast' },
  { id: 14, code: 'US_JOLTS',         name: 'JOLTS Job Openings',    short: 'JOLTS',   cluster: 'LABOR',     category: 'Direction vs Prior',           scoringCategory: 'direction_vs_prior' },
];

const SUB_DEF_BY_CODE = new Map(SUB_DEFS.map((d) => [d.code, d]));

// Cluster membership for composition-flag math (SENTIMENT excluded by spec).
const INFLATION_CODES = SUB_DEFS.filter((d) => d.cluster === 'INFLATION').map((d) => d.code);
const GROWTH_CODES = SUB_DEFS.filter((d) => d.cluster === 'GROWTH').map((d) => d.code);
const LABOR_CODES = SUB_DEFS.filter((d) => d.cluster === 'LABOR').map((d) => d.code);

// Staleness ceiling (days since last release) per cadence — generous buffers
// over the nominal cadence so weekends/holidays don't false-flag.
const STALE_CEILING: Record<Ind9Cadence, number> = {
  Daily: 6,
  Weekly: 16,
  Monthly: 70,
  Quarterly: 200,
};

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

const MINUS = '−'; // unicode minus, matches frontend convention

function signedScore(score: Ind9SubScore): string {
  if (score === null) return 'n/a';
  if (score > 0) return '+1';
  if (score < 0) return `${MINUS}1`;
  return '0';
}

const PERCENT_CODES = new Set([
  'US_GDP_QOQ', 'US_RETAIL_MOM', 'US_CPI_YOY', 'US_PPI_MOM', 'US_PCE_YOY', 'US_UNEMP', 'US_02Y_SMA',
]);
const THOUSANDS_CODES = new Set(['US_NFP', 'US_ADP', 'US_JOBLESS_CLAIMS']); // stored in K units
const MILLIONS_CODES = new Set(['US_JOLTS']); // stored in M units

/** Format a raw numeric reading for display, per indicator code. */
function fmtValue(code: string, v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (PERCENT_CODES.has(code)) {
    const dp = code === 'US_02Y_SMA' ? 2 : 1;
    return `${v.toFixed(dp)}%`;
  }
  if (THOUSANDS_CODES.has(code)) {
    const sign = v > 0 ? '+' : v < 0 ? MINUS : '';
    return `${sign}${Math.abs(Math.round(v))}K`;
  }
  if (MILLIONS_CODES.has(code)) return `${v.toFixed(2)}M`;
  return v.toFixed(1); // PMI / index levels (ISM, Consumer Confidence)
}

function cadenceFromFrequency(freq: string | null): Ind9Cadence {
  switch (freq) {
    case 'daily': return 'Daily';
    case 'weekly': return 'Weekly';
    case 'quarterly': return 'Quarterly';
    default: return 'Monthly';
  }
}

function dataSourceLabel(src: string | null): string {
  switch (src) {
    case 'forex_factory': return 'Forex Factory';
    case 'fred': return 'FRED';
    case 'manual': return 'Manual';
    case 'eodhd': return 'EODHD';
    case 'derived': return 'Derived';
    default: return src ? src.toUpperCase() : 'Unknown';
  }
}

function cmp(a: number, b: number): string {
  if (a > b) return '>';
  if (a < b) return '<';
  return '=';
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring + reasoning (mirrors ind9-bridge category logic)
// ─────────────────────────────────────────────────────────────────────────────

interface ScoredRelease {
  score: Ind9SubScore;
  reference: number | null;
  referenceKind: UsdLabSubIndicator['referenceKind'];
  fallbackUsed: boolean;
}

function scoreRelease(
  scoringCategory: ScoringCategory,
  actual: number | null,
  forecast: number | null,
  prior: number | null,
): ScoredRelease {
  if (actual === null || !Number.isFinite(actual)) {
    return { score: null, reference: null, referenceKind: 'none', fallbackUsed: false };
  }
  switch (scoringCategory) {
    case 'absolute_threshold':
      return {
        score: actual > ABSOLUTE_THRESHOLD ? 1 : actual < ABSOLUTE_THRESHOLD ? -1 : 0,
        reference: ABSOLUTE_THRESHOLD,
        referenceKind: 'threshold',
        fallbackUsed: false,
      };
    case 'vs_forecast': {
      const baseline = forecast ?? prior;
      if (baseline === null) return { score: null, reference: null, referenceKind: 'none', fallbackUsed: false };
      return {
        score: actual > baseline ? 1 : actual < baseline ? -1 : 0,
        reference: baseline,
        referenceKind: forecast !== null ? 'forecast' : 'prior',
        fallbackUsed: forecast === null,
      };
    }
    case 'direction_vs_prior':
      if (prior === null) return { score: null, reference: null, referenceKind: 'none', fallbackUsed: false };
      return { score: actual > prior ? 1 : actual < prior ? -1 : 0, reference: prior, referenceKind: 'prior', fallbackUsed: false };
    case 'inverted_vs_prior':
      if (prior === null) return { score: null, reference: null, referenceKind: 'none', fallbackUsed: false };
      return { score: actual > prior ? -1 : actual < prior ? 1 : 0, reference: prior, referenceKind: 'prior', fallbackUsed: false };
    case 'sma_direction':
      if (prior === null) return { score: null, reference: null, referenceKind: 'none', fallbackUsed: false };
      return { score: actual > prior ? 1 : actual < prior ? -1 : 0, reference: prior, referenceKind: 'sma_5d', fallbackUsed: false };
  }
}

function buildReasoning(
  def: SubDef,
  actual: number | null,
  scored: ScoredRelease,
): string {
  const fA = fmtValue(def.code, actual);
  const fRef = fmtValue(def.code, scored.reference);
  const s = signedScore(scored.score);
  if (actual === null || scored.score === null) return 'No current reading — score suppressed.';
  switch (def.scoringCategory) {
    case 'absolute_threshold': {
      const tail = scored.score > 0 ? 'expansion → USD strong' : scored.score < 0 ? 'contraction → USD weak' : 'at threshold';
      return `${fA} ${cmp(actual, ABSOLUTE_THRESHOLD)} 50.0 → ${s} (${tail})`;
    }
    case 'vs_forecast': {
      const refLabel = scored.referenceKind === 'forecast' ? 'Forecast' : 'Prior';
      const fb = scored.fallbackUsed ? ' [forecast missing → prior]' : '';
      return `Actual ${fA} ${cmp(actual, scored.reference!)} ${refLabel} ${fRef} → ${s}${fb}`;
    }
    case 'direction_vs_prior':
      return `Actual ${fA} ${cmp(actual, scored.reference!)} Prior ${fRef} → ${s} (rising = USD strong)`;
    case 'inverted_vs_prior':
      return `Actual ${fA} ${cmp(actual, scored.reference!)} Prior ${fRef} → ${s} (rising = USD weak; inverted)`;
    case 'sma_direction':
      return `SMA ${fA} ${cmp(actual, scored.reference!)} 5d-ago ${fRef} → ${s} (SMA ${actual > scored.reference! ? 'rising' : actual < scored.reference! ? 'falling' : 'flat'})`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5-tier bucketing + composition flag (computed from the 14 sub-indicators)
// ─────────────────────────────────────────────────────────────────────────────

function bucketToNiftyScore(raw: number): number {
  if (raw <= -7) return 2;
  if (raw <= -4) return 1;
  if (raw <= 3) return 0;
  if (raw <= 6) return -1;
  return -2;
}

function buildTiers(raw: number | null): UsdLabTier[] {
  const defs: Omit<UsdLabTier, 'current'>[] = [
    { min: null, max: -7, niftyScore: 2, read: 'deeply weak USD' },
    { min: -6, max: -4, niftyScore: 1, read: 'weak USD' },
    { min: -3, max: 3, niftyScore: 0, read: 'neutral' },
    { min: 4, max: 6, niftyScore: -1, read: 'strong USD' },
    { min: 7, max: null, niftyScore: -2, read: 'deeply strong USD' },
  ];
  return defs.map((t) => ({
    ...t,
    current:
      raw !== null &&
      (t.min === null || raw >= t.min) &&
      (t.max === null || raw <= t.max),
  }));
}

type ScoreMap = Record<string, Ind9SubScore>;

function countNeg(codes: string[], scores: ScoreMap): number {
  return codes.reduce((acc, c) => acc + (scores[c] !== null && scores[c] !== undefined && (scores[c] as number) < 0 ? 1 : 0), 0);
}
function countPos(codes: string[], scores: ScoreMap): number {
  return codes.reduce((acc, c) => acc + (scores[c] !== null && scores[c] !== undefined && (scores[c] as number) > 0 ? 1 : 0), 0);
}

const FLAG_READ: Record<Exclude<Ind9CompositionFlag, null>, string> = {
  INFLATION_LED: 'USD weakness led by inflation cooling — equity-supportive.',
  DEMAND_DESTRUCTION: 'USD weakness from demand deterioration — equity-stalling.',
  MIXED: 'Ambiguous composition. No directional read.',
  INFLATION_HOT: 'USD strength led by hot inflation — equity-bearish (mirror).',
  DEMAND_REACCEL: 'USD strength from demand re-acceleration — mixed for equity (mirror).',
  MIXED_HOT: 'Ambiguous composition (strong side). No directional read.',
};

/** Classify the composition flag + decision path from the 14 sub-indicator scores. */
function computeComposition(raw: number | null, scores: ScoreMap): UsdLabComposition {
  const iNeg = countNeg(INFLATION_CODES, scores);
  const glNeg = countNeg(GROWTH_CODES, scores) + countNeg(LABOR_CODES, scores);
  const iPos = countPos(INFLATION_CODES, scores);
  const glPos = countPos(GROWTH_CODES, scores) + countPos(LABOR_CODES, scores);

  const base = { iNeg, glNeg, iPos, glPos };

  if (raw === null || Math.abs(raw) < 4) {
    return {
      ...base,
      flag: null,
      activated: false,
      side: null,
      checks: [],
      read: 'Composition flag inactive — |Ind 9 raw| < 4 (not in trigger range).',
    };
  }

  if (raw <= -4) {
    const inflationLed = iNeg >= 2;
    const demandDestruction = glNeg >= 6 && iNeg <= 1;
    const flag: Ind9CompositionFlag = inflationLed ? 'INFLATION_LED' : demandDestruction ? 'DEMAND_DESTRUCTION' : 'MIXED';
    const checks: UsdLabFlagCheck[] = [
      { flag: 'INFLATION_LED', passed: inflationLed, detail: `I_neg = ${iNeg} ${iNeg >= 2 ? '≥' : '<'} 2` },
      { flag: 'DEMAND_DESTRUCTION', passed: demandDestruction, detail: `GL_neg = ${glNeg} ${glNeg >= 6 ? '≥' : '<'} 6 AND I_neg = ${iNeg} ${iNeg <= 1 ? '≤' : '>'} 1` },
      { flag: 'MIXED', passed: !inflationLed && !demandDestruction, detail: 'fallback when neither rule fires' },
    ];
    return { ...base, flag, activated: true, side: 'weak', checks, read: FLAG_READ[flag] };
  }

  // raw >= +4 — mirror (USD strength) side
  const inflationHot = iPos >= 2;
  const demandReaccel = glPos >= 6 && iPos <= 1;
  const flag: Ind9CompositionFlag = inflationHot ? 'INFLATION_HOT' : demandReaccel ? 'DEMAND_REACCEL' : 'MIXED_HOT';
  const checks: UsdLabFlagCheck[] = [
    { flag: 'INFLATION_HOT', passed: inflationHot, detail: `I_pos = ${iPos} ${iPos >= 2 ? '≥' : '<'} 2` },
    { flag: 'DEMAND_REACCEL', passed: demandReaccel, detail: `GL_pos = ${glPos} ${glPos >= 6 ? '≥' : '<'} 6 AND I_pos = ${iPos} ${iPos <= 1 ? '≤' : '>'} 1` },
    { flag: 'MIXED_HOT', passed: !inflationHot && !demandReaccel, detail: 'fallback when neither mirror rule fires' },
  ];
  return { ...base, flag, activated: true, side: 'strong', checks, read: FLAG_READ[flag] };
}

// ─────────────────────────────────────────────────────────────────────────────
// sourceMetadata parsing
// ─────────────────────────────────────────────────────────────────────────────

interface StoredSub {
  code: string;
  actual: number | null;
  forecast: number | null;
  prior: number | null;
  score: number | null;
  parseable: boolean;
}

function parseSubIndicators(meta: unknown): StoredSub[] {
  if (!meta || typeof meta !== 'object') return [];
  const arr = (meta as { subIndicators?: unknown }).subIndicators;
  if (!Array.isArray(arr)) return [];
  const out: StoredSub[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.code !== 'string') continue;
    out.push({
      code: e.code,
      actual: typeof e.actual === 'number' ? e.actual : null,
      forecast: typeof e.forecast === 'number' ? e.forecast : null,
      prior: typeof e.prior === 'number' ? e.prior : null,
      score: typeof e.score === 'number' ? e.score : null,
      parseable: e.parseable === true,
    });
  }
  return out;
}

function rawCompositeFromMeta(meta: unknown, fallbackValue: number): number {
  if (meta && typeof meta === 'object') {
    const rc = (meta as { rawComposite?: unknown }).rawComposite;
    if (typeof rc === 'number' && Number.isFinite(rc)) return rc;
  }
  return fallbackValue;
}

function toSubScore(n: number | null): Ind9SubScore {
  if (n === null) return null;
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the full USD Lab (Indicator 9) detail from real data.
 *
 * Source of truth: the IND_NIFTY_09_USD_WEAKNESS data points written by the
 * ind9 bridge (sourceMetadata.subIndicators). Everything — raw composite, the
 * 5-tier NIFTY-facing score, cluster math and the composition flag — is
 * recomputed from those 14 scores so the page is internally self-consistent.
 *
 * Returns null when the Ind 9 indicator/data point does not exist at all.
 */
export async function getUsdLabDetail(): Promise<UsdLabResponse | null> {
  const ind9Ind = await prisma.indicator.findUnique({
    where: { code: IND9_CODE },
    select: { id: true },
  });
  if (!ind9Ind) return null;

  // Last 30 Ind 9 composites (newest first) — drives both current + history.
  const ind9Points = await prisma.dataPoint.findMany({
    where: { indicatorId: ind9Ind.id, isCurrent: true },
    orderBy: { observationDate: 'desc' },
    take: HISTORY_DEPTH,
    select: { observationDate: true, value: true, sourceMetadata: true },
  });

  if (ind9Points.length === 0) return null;

  const latest = ind9Points[0];
  const asOf = latest.observationDate;
  const storedSubs = parseSubIndicators(latest.sourceMetadata);
  const storedByCode = new Map(storedSubs.map((s) => [s.code, s]));

  // Score map (USD-strength) for the current composition computation.
  const scoreMap: ScoreMap = {};
  for (const d of SUB_DEFS) scoreMap[d.code] = toSubScore(storedByCode.get(d.code)?.score ?? null);

  const rawComposite = storedSubs.length > 0
    ? rawCompositeFromMeta(latest.sourceMetadata, Number(latest.value))
    : null;
  const niftyScore = rawComposite === null ? null : bucketToNiftyScore(rawComposite);

  // Indicator metadata (cadence / source) + per-sub last release dates.
  const codes = SUB_DEFS.map((d) => d.code);
  const indicators = await prisma.indicator.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, frequency: true, dataSource: true },
  });
  const indByCode = new Map(indicators.map((i) => [i.code, i]));
  const idToCode = new Map(indicators.map((i) => [i.id, i.code]));

  const subPoints = await prisma.dataPoint.findMany({
    where: { indicatorId: { in: indicators.map((i) => i.id) }, isCurrent: true, observationDate: { lte: asOf } },
    orderBy: { observationDate: 'desc' },
    select: { indicatorId: true, observationDate: true },
  });
  const lastReleaseByCode = new Map<string, Date>();
  for (const dp of subPoints) {
    const code = idToCode.get(dp.indicatorId);
    if (code && !lastReleaseByCode.has(code)) lastReleaseByCode.set(code, dp.observationDate);
  }

  // Build the 14 rich sub-indicators (display order).
  let staleCount = 0;
  let dataCount = 0;
  let parseableCount = 0;

  const subIndicators: UsdLabSubIndicator[] = SUB_DEFS.map((def) => {
    const stored = storedByCode.get(def.code);
    const ind = indByCode.get(def.code);
    const cadence = cadenceFromFrequency(ind?.frequency ?? null);
    const actual = stored?.actual ?? null;
    const forecast = stored?.forecast ?? null;
    const prior = stored?.prior ?? null;
    const score = toSubScore(stored?.score ?? null);

    const scored = scoreRelease(def.scoringCategory, actual, forecast, prior);
    const reasoning = buildReasoning(def, actual, { ...scored, score });

    const lastRelease = lastReleaseByCode.get(def.code) ?? null;
    const staleDays = lastRelease ? daysBetween(asOf, lastRelease) : null;
    const isStale = staleDays !== null && staleDays > STALE_CEILING[cadence];

    if (actual !== null) dataCount += 1;
    if (score !== null) parseableCount += 1;
    if (isStale) staleCount += 1;

    return {
      id: def.id,
      code: def.code,
      name: def.name,
      short: def.short,
      category: def.category,
      cluster: def.cluster,
      score,
      actual: fmtValue(def.code, actual),
      forecast: def.scoringCategory === 'vs_forecast' ? fmtValue(def.code, forecast) : null,
      prior: fmtValue(def.code, prior),
      threshold: def.scoringCategory === 'absolute_threshold' ? `${ABSOLUTE_THRESHOLD}.0` : null,
      reference: fmtValue(def.code, scored.reference),
      referenceKind: scored.referenceKind,
      reasoning,
      lastReleaseDate: lastRelease ? isoDate(lastRelease) : null,
      cadence,
      dataSource: dataSourceLabel(ind?.dataSource ?? null),
      isStale,
      staleDays,
      fallbackUsed: scored.fallbackUsed,
    };
  });

  // Cluster rollups.
  const clusterOrder: Ind9Cluster[] = ['INFLATION', 'GROWTH', 'LABOR', 'SENTIMENT'];
  const clusters = clusterOrder.map((cl) => {
    const members = subIndicators.filter((s) => s.cluster === cl);
    const sum = members.reduce((a, s) => a + (s.score ?? 0), 0);
    return {
      cluster: cl,
      sum,
      negCount: members.filter((s) => (s.score ?? 0) < 0).length,
      posCount: members.filter((s) => (s.score ?? 0) > 0).length,
      includedInFlag: cl !== 'SENTIMENT',
    };
  });

  const composition = computeComposition(rawComposite, scoreMap);

  // History — recompute raw/score/flag from each date's 14 sub-indicators.
  const history: UsdLabHistoryPoint[] = ind9Points
    .map((p) => {
      const subs = parseSubIndicators(p.sourceMetadata);
      const raw = subs.length > 0 ? rawCompositeFromMeta(p.sourceMetadata, Number(p.value)) : Number(p.value);
      const m: ScoreMap = {};
      for (const d of SUB_DEFS) m[d.code] = toSubScore(subs.find((s) => s.code === d.code)?.score ?? null);
      return {
        date: isoDate(p.observationDate),
        rawComposite: raw,
        niftyScore: bucketToNiftyScore(raw),
        compositionFlag: computeComposition(raw, m).flag,
      };
    })
    .reverse(); // oldest → newest for the chart

  // Data quality.
  const suppressed = rawComposite === null || (dataCount < 12 && staleCount >= 3);
  const computability: UsdLabDataQuality['computability'] = suppressed
    ? 'SUPPRESSED'
    : dataCount >= 12
      ? 'FULL'
      : 'DEGRADED';

  const dataQuality: UsdLabDataQuality = {
    dataCount,
    parseableCount,
    staleCount,
    computability,
    suppressed,
  };

  return {
    asOf: isoDate(asOf),
    rawComposite,
    niftyScore,
    tiers: buildTiers(rawComposite),
    composition,
    subIndicators,
    clusters,
    history,
    dataQuality,
  };
}

/**
 * Last-N release history for a single Ind 9 sub-indicator (drawer view).
 * Recomputes the per-release score from the data point's own actual/forecast/
 * previous values via the same category rule. Returns null for unknown codes.
 */
export async function getUsdLabSubIndicatorHistory(
  code: string,
  limit = 12,
): Promise<UsdLabSubIndicatorDetail | null> {
  const def = SUB_DEF_BY_CODE.get(code);
  if (!def) return null;

  const ind = await prisma.indicator.findUnique({
    where: { code },
    select: { id: true, frequency: true, dataSource: true },
  });
  if (!ind) return null;

  const points = await prisma.dataPoint.findMany({
    where: { indicatorId: ind.id, isCurrent: true },
    orderBy: { observationDate: 'desc' },
    take: limit,
    select: { observationDate: true, value: true, forecastValue: true, previousValue: true },
  });

  const releases: UsdLabReleaseRow[] = points.map((p) => {
    const actual = Number(p.value);
    const forecast = p.forecastValue !== null ? Number(p.forecastValue) : null;
    const prior = p.previousValue !== null ? Number(p.previousValue) : null;
    const scored = scoreRelease(def.scoringCategory, actual, forecast, prior);
    return {
      date: isoDate(p.observationDate),
      actual: fmtValue(code, actual),
      reference: fmtValue(code, scored.reference),
      referenceKind: scored.referenceKind,
      score: scored.score,
    };
  });

  return {
    code: def.code,
    name: def.name,
    short: def.short,
    category: def.category,
    cluster: def.cluster,
    cadence: cadenceFromFrequency(ind.frequency),
    dataSource: dataSourceLabel(ind.dataSource),
    releases,
  };
}

import { prisma } from '@core/db/prisma';
import type { BiasType, IndicatorValue, CotValue } from './oracle.types';

// ============================================================================
// Bias mapping — uses frontend's getBias thresholds from assets.ts exactly
// ============================================================================

export function scoreToFrontendBias(score: number): BiasType {
  if (score >= 5) return 'Strong Bullish';
  if (score >= 3) return 'Bullish';
  if (score >= -2) return 'Neutral';
  if (score >= -4) return 'Bearish';
  return 'Strong Bearish';
}

// ============================================================================
// COT value clamping to CotValue union
// ============================================================================

export function clampCotValue(n: number): CotValue {
  if (n >= 2) return 2;
  if (n === 1) return 1;
  if (n === 0) return 0;
  if (n === -1) return -1;
  return -2;
}

// ============================================================================
// Indicator score → IndicatorValue (-1/0/+1/null)
// ============================================================================

export function scoreToIndicatorValue(
  score: number | null,
  outcome: 'scored' | 'carry_forward' | 'insufficient_data' | 'absent',
): IndicatorValue {
  if (outcome === 'insufficient_data' || outcome === 'absent' || score === null) return null;
  if (score > 0) return 1;
  if (score < 0) return -1;
  return 0;
}

/** Map pairScore (-2..+2) to IndicatorValue. null when row is excluded. */
export function pairScoreToIndicatorValue(
  pairScore: number,
  rowIncluded: boolean,
): IndicatorValue {
  if (!rowIncluded) return null;
  if (pairScore > 0) return 1;
  if (pairScore < 0) return -1;
  return 0;
}

// ============================================================================
// 12-week score history
// ============================================================================

/** Returns the Friday date (or nearest prior day) for a given offset in weeks. */
function getFridayDate(weeksAgo: number, asOf: Date): Date {
  const d = new Date(asOf);
  // Move to this week's Friday (day 5)
  const dayOfWeek = d.getUTCDay(); // 0=Sun..6=Sat
  const daysToFriday = dayOfWeek >= 5 ? dayOfWeek - 5 : dayOfWeek + 2; // days since last Friday
  d.setUTCDate(d.getUTCDate() - daysToFriday - weeksAgo * 7);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Compute 12-week net score history for an asset (currency/gold).
 * Returns oldest-first array of 12 totalScores.
 * Missing weeks filled with 0.
 */
export async function compute12WeekHistory(
  assetId: string,
  asOf: Date,
): Promise<number[]> {
  const fridays = Array.from({ length: 12 }, (_, i) => getFridayDate(11 - i, asOf));
  const earliest = fridays[0];
  const latest = fridays[11];

  const rows = await prisma.edgefinderScorecard.findMany({
    where: {
      assetId,
      isCurrent: true,
      observationDate: { gte: earliest, lte: latest },
    },
    orderBy: { observationDate: 'asc' },
    select: { observationDate: true, totalScore: true },
  });

  return fridays.map((friday) => {
    const prior = rows.filter(
      (r) => r.observationDate.getTime() <= friday.getTime(),
    );
    return prior.length > 0 ? prior[prior.length - 1].totalScore : 0;
  });
}

/**
 * Compute 12-week net score history for an FX pair.
 * Returns oldest-first array of 12 totalScores.
 */
export async function computePair12WeekHistory(
  pairId: string,
  asOf: Date,
): Promise<number[]> {
  const fridays = Array.from({ length: 12 }, (_, i) => getFridayDate(11 - i, asOf));
  const earliest = fridays[0];
  const latest = fridays[11];

  const rows = await prisma.edgefinderPairScore.findMany({
    where: {
      pairId,
      isCurrent: true,
      scoreDate: { gte: earliest, lte: latest },
    },
    orderBy: { scoreDate: 'asc' },
    select: { scoreDate: true, totalScore: true },
  });

  return fridays.map((friday) => {
    const prior = rows.filter(
      (r) => r.scoreDate.getTime() <= friday.getTime(),
    );
    return prior.length > 0 ? prior[prior.length - 1].totalScore : 0;
  });
}

// ============================================================================
// Aging check
// ============================================================================
//
// Renamed from isStale. This codebase now has THREE distinct staleness-
// adjacent mechanisms, and calling any of them "stale" is exactly the kind
// of ambiguity that previously produced five independent win-rate
// implementations — a name collision, not a logic collision, is what let
// that happen unnoticed.
//
//   AGING (here)       — flat 60-day tolerance on observationDate. Value-
//                         driven, indicator-level, frequency-blind. Answers
//                         "is the number on file old in absolute terms."
//   OVERDUE (B1, see
//   overdue-resolver.ts) — a specific scheduled calendar_events row passed
//                         >24h ago with no matching DataPoint. Event-driven,
//                         per-variant. Answers "was a specific release missed."
//   DataHealth severity — frequency-scaled bands (data-health.ts), shared
//                         with NIFTY's data-gaps report. Answers "is the
//                         number old relative to THIS indicator's own cadence."
//
// All three stay running. None is a fallback for another — each answers a
// genuinely different question, and NIFTY relies on aging + DataHealth today
// (it has zero calendar events, so overdue never applies to it).
//
// KNOWN OPEN ITEM, explicitly not resolved here: aging's flat 60 days is a
// cruder version of what DataHealth already does correctly with per-
// frequency bands (daily 5/14, weekly 10/21, monthly 45/75, quarterly
// 100/130, event_driven 365/730). A quarterly indicator releasing exactly on
// schedule trips aging's flat 60-day check while DataHealth correctly gives
// it 100/130 days — the two can and will disagree on the same indicator.
// Replacing aging with DataHealth's bands is a plausible future
// consolidation, but it is its own prompt with its own regression check
// against every current aging consumer. Do not merge them under time
// pressure; this comment is the flag for that future work, not a directive
// to do it now.
export function isAging(observationDate: Date, asOfDate: Date): boolean {
  const diffMs = asOfDate.getTime() - observationDate.getTime();
  return diffMs > 60 * 24 * 60 * 60 * 1000;
}

// ============================================================================
// Date formatting
// ============================================================================

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Format as "Mar 27, 2026" */
export function formatDateShort(date: Date): string {
  return `${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

// ============================================================================
// Number / value formatting
// ============================================================================

/** Format percentage with sign: "+3.8%" or "-1.2%" */
export function formatPercentWithSign(value: number, decimals = 1): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

/** Format a number with sign (no percent): "+3.8" or "-1.2" */
export function formatNumberWithSign(value: number, decimals = 1): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}`;
}

/**
 * Format indicator value for display based on indicator code.
 * Returns a display string suitable for the scorecard UI.
 */
export function formatIndicatorValue(code: string, value: number | null): string {
  if (value === null) return '—';
  if (code === 'US_02Y_SMA') return `${value.toFixed(2)}%`;
  if (code === 'US_NFP' || code === 'US_ADP') {
    return `${Math.round(value)}K`;
  }
  if (code === 'US_JOBLESS_CLAIMS') return `${Math.round(value)}K`;
  if (code === 'US_JOLTS') return `${value.toFixed(2)}M`;
  if (isPercentIndicator(code)) return `${value.toFixed(1)}%`;
  return value.toFixed(1);
}

function isPercentIndicator(code: string): boolean {
  const pctCodes = [
    'US_GDP_QOQ', 'EU_GDP_QOQ', 'UK_GDP_MOM', 'JP_GDP_QOQ',
    'US_RETAIL_MOM', 'EU_RETAIL_MOM', 'UK_RETAIL_MOM', 'JP_RETAIL_YOY',
    'US_CPI_YOY', 'EU_CPI_YOY', 'UK_CPI_YOY', 'JP_CPI_YOY',
    'US_PPI_MOM', 'EU_PPI_MOM', 'UK_PPI_MOM', 'JP_PPI_YOY',
    'US_PCE_YOY',
    'US_UNEMP', 'EU_UNEMP', 'UK_UNEMP', 'JP_UNEMP',
    'JP_HSHLD_SPEND',
    'US_FED_RATE', 'EU_ECB_RATE', 'UK_BOE_RATE', 'JP_BOJ_RATE',
  ];
  return pctCodes.includes(code);
}

/**
 * Compute surprise string: actual - forecast, formatted per indicator.
 * Returns "—" if forecast is null.
 */
export function computeSurprise(
  code: string,
  actual: number,
  forecast: number | null,
): string {
  if (forecast === null) return null as unknown as string; // caller checks
  const diff = actual - forecast;
  if (code === 'US_NFP' || code === 'US_ADP') {
    const k = Math.round(diff);
    return `${k >= 0 ? '+' : ''}${k}K`;
  }
  if (code === 'US_JOBLESS_CLAIMS') {
    const k = Math.round(diff);
    return `${k >= 0 ? '+' : ''}${k}K`;
  }
  if (code === 'US_JOLTS') {
    return `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}M`;
  }
  if (isPercentIndicator(code)) {
    return formatPercentWithSign(diff);
  }
  return formatNumberWithSign(diff);
}

// computeNextRelease (frequency+30/90/7-day arithmetic) removed. nextRelease
// now derives from stored calendar_events — the actual scheduled occurrence,
// not a guess from cadence. See getNextRelease in calendar.service.ts and its
// call site in oracle.routes.ts's heatmap handler. A guessed date and a real
// one are not the same fact, and keeping both around is how a arithmetic
// nobody trusts survives next to the truth it was standing in for. (See B1.)

// ============================================================================
// Indicator code → column/section mappings
// ============================================================================

/** Maps indicator code to AssetData column key. */
export const INDICATOR_SLOT: Record<string, keyof typeof EMPTY_INDICATOR_SLOTS> = {
  // GDP
  US_GDP_QOQ: 'gdp', EU_GDP_QOQ: 'gdp', UK_GDP_MOM: 'gdp', JP_GDP_QOQ: 'gdp',
  // Manufacturing PMI
  US_ISM_MFG: 'pmiM', EU_MFG_PMI: 'pmiM', UK_MFG_PMI: 'pmiM', JP_MFG_PMI: 'pmiM',
  // Services PMI
  US_ISM_SVC: 'pmiS', EU_SVC_PMI: 'pmiS', UK_SVC_PMI: 'pmiS', JP_SVC_PMI: 'pmiS',
  // Retail Sales
  US_RETAIL_MOM: 'retail', EU_RETAIL_MOM: 'retail', UK_RETAIL_MOM: 'retail', JP_RETAIL_YOY: 'retail',
  // Consumer Confidence
  US_CB_CONSCONF: 'consConf', EU_CCI: 'consConf', UK_GFK: 'consConf', JP_CONSCONF: 'consConf',
  // CPI
  US_CPI_YOY: 'cpi', EU_CPI_YOY: 'cpi', UK_CPI_YOY: 'cpi', JP_CPI_YOY: 'cpi',
  // PPI
  US_PPI_MOM: 'ppi', EU_PPI_MOM: 'ppi', UK_PPI_MOM: 'ppi', JP_PPI_YOY: 'ppi',
  // PCE
  US_PCE_YOY: 'pce',
  // US02Y SMA (yield)
  US_02Y_SMA: 'yield',
  // NFP
  US_NFP: 'nfp',
  // Unemployment
  US_UNEMP: 'unemp', EU_UNEMP: 'unemp', UK_UNEMP: 'unemp', JP_UNEMP: 'unemp',
  // Jobless Claims
  US_JOBLESS_CLAIMS: 'claims',
  // ADP
  US_ADP: 'adp',
  // JOLTS
  US_JOLTS: 'jolts',
};

export const EMPTY_INDICATOR_SLOTS = {
  gdp: null as (1 | 0 | -1 | null),
  pmiM: null as (1 | 0 | -1 | null),
  pmiS: null as (1 | 0 | -1 | null),
  retail: null as (1 | 0 | -1 | null),
  consConf: null as (1 | 0 | -1 | null),
  cpi: null as (1 | 0 | -1 | null),
  ppi: null as (1 | 0 | -1 | null),
  pce: null as (1 | 0 | -1 | null),
  yield: null as (1 | 0 | -1 | null),
  nfp: null as (1 | 0 | -1 | null),
  unemp: null as (1 | 0 | -1 | null),
  claims: null as (1 | 0 | -1 | null),
  adp: null as (1 | 0 | -1 | null),
  jolts: null as (1 | 0 | -1 | null),
  // Phase 3 additions. These are NEW slots, not reassignments — every existing
  // slot keeps its name, type and meaning. Each of the four new template rows
  // needs its own slot because the obvious existing slot is already occupied by
  // a different row (Tokyo Core CPI vs CPI, AU Employment Change vs NFP), and
  // sharing one would make the last row written silently clobber the first.
  cashEarnings: null as (1 | 0 | -1 | null), // Jobs
  auEmpl: null as (1 | 0 | -1 | null),       // Jobs
  tokyoCpi: null as (1 | 0 | -1 | null),     // Inflation
  caixinPmi: null as (1 | 0 | -1 | null),    // Economic Growth
};

/**
 * Maps a pair template row's `rowName` (as stored in `edgefinder_pair_scores.
 * rowBreakdown`) to the Top-Setups AssetData indicator slot.
 *
 * IMPORTANT: these keys MUST match the `pair_template_rows.displayName` values
 * the pair-score assembly writes into `rowBreakdown` — NOT the labels in the
 * static `pair-template.config.ts` array (which is superseded at runtime by
 * `loadPairTemplateFromDb()`). Six Jobs/Rates rows previously mismatched
 * (e.g. "Employment Change (NFP)" vs "NFP / Employment"), which silently left
 * the nfp/unemp/claims/jolts/adp/yield columns blank for every FX pair.
 */
export const PAIR_ROW_TO_SLOT: Record<string, keyof typeof EMPTY_INDICATOR_SLOTS> = {
  'GDP': 'gdp',
  'Manufacturing PMI': 'pmiM',
  'Services PMI': 'pmiS',
  'Retail Sales': 'retail',
  'Consumer Confidence': 'consConf',
  'CPI': 'cpi',
  'PPI': 'ppi',
  'PCE': 'pce',
  'Interest Rates': 'yield',
  'Employment Change (NFP)': 'nfp',
  'Unemployment Rate': 'unemp',
  'Weekly Jobless Claims': 'claims',
  'JOLTS Openings': 'jolts',
  'ADP Employment': 'adp',
  // Phase 3: the four rows activated in Phase 2, which computed and stored but
  // had no slot and so never surfaced. Groups follow uiGroupToSectionLabel:
  // Jobs -> JOBS MARKET, Inflation -> INFLATION, Growth -> ECONOMIC GROWTH.
  'Labor Cash Earnings': 'cashEarnings',
  'AU Employment Change': 'auEmpl',
  'Tokyo Core CPI': 'tokyoCpi',
  'China Caixin Mfg PMI': 'caixinPmi',
};

/**
 * uiGroup for each slot, so a consumer can group the screener columns without
 * re-deriving it from the row name. Mirrors the AssetData field comments.
 */
export const SLOT_UI_GROUP: Record<keyof typeof EMPTY_INDICATOR_SLOTS, 'Growth' | 'Inflation' | 'Jobs'> = {
  gdp: 'Growth', pmiM: 'Growth', pmiS: 'Growth', retail: 'Growth', consConf: 'Growth',
  caixinPmi: 'Growth',
  cpi: 'Inflation', ppi: 'Inflation', pce: 'Inflation', yield: 'Inflation', tokyoCpi: 'Inflation',
  nfp: 'Jobs', unemp: 'Jobs', claims: 'Jobs', adp: 'Jobs', jolts: 'Jobs',
  cashEarnings: 'Jobs', auEmpl: 'Jobs',
};

// ============================================================================
// Section label / color / category helpers
// ============================================================================

export function uiGroupToSectionLabel(uiGroup: string): 'ECONOMIC GROWTH' | 'INFLATION' | 'JOBS MARKET' | null {
  switch (uiGroup) {
    case 'Growth':
    case 'Sentiment':
      return 'ECONOMIC GROWTH';
    case 'Inflation':
    case 'Rates':
      return 'INFLATION';
    case 'Jobs':
      return 'JOBS MARKET';
    default:
      return null;
  }
}

export const SECTION_COLORS: Record<string, string> = {
  'ECONOMIC GROWTH': '#3B82F6',
  'INFLATION': '#818CF8',
  'JOBS MARKET': '#F59E0B',
};

export function dbFrequencyToHeatmapFrequency(
  freq: string,
): 'Monthly' | 'Quarterly' | 'Weekly' | 'Daily' {
  switch (freq) {
    case 'monthly': return 'Monthly';
    case 'quarterly': return 'Quarterly';
    case 'weekly': return 'Weekly';
    default: return 'Daily';
  }
}

// ============================================================================
// Asset display metadata
// ============================================================================
//
// PHASE 3: the hardcoded instrument lists that used to live here —
// ORACLE_ASSETS, SCORECARD_KEY_TO_ASSET_CODE, SCORECARD_ASSET_META,
// PAIR_COT_CURRENCY, COT_ASSETS, COT_ASSET_FLAG, COT_ASSET_TYPE and
// FX_PAIR_META — have been deleted. Every one of them is now derived from the
// `assets` table by `instrument-registry.ts`, and their display strings (flag,
// name, ordering, the 'Gold' key alias) live in Asset.metadata.display as data.
//
// An instrument added to the registry now appears everywhere at once, instead
// of computing correctly in the database and appearing nowhere.

/** Category color config matching frontend. */
export const CATEGORY_COLORS: Record<string, string> = {
  'ECONOMIC GROWTH': '#3B82F6',
  'INFLATION': '#818CF8',
  'JOBS MARKET': '#F59E0B',
  'Growth': '#3B82F6',
  'Inflation': '#818CF8',
  'Jobs': '#F59E0B',
};

/** UI group to heatmap category. */
export function uiGroupToHeatmapCategory(uiGroup: string | null): 'ECONOMIC GROWTH' | 'INFLATION' | 'JOBS MARKET' | null {
  switch (uiGroup) {
    case 'Growth':
    case 'Sentiment':
      return 'ECONOMIC GROWTH';
    case 'Inflation':
    case 'Rates':
      return 'INFLATION';
    case 'Jobs':
      return 'JOBS MARKET';
    default:
      return null;
  }
}

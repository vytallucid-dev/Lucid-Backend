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
// Staleness check
// ============================================================================

export function isStale(observationDate: Date, asOfDate: Date): boolean {
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

/**
 * Compute approximate next release from last release date and frequency.
 * Returns formatted string for frontend display.
 */
export function computeNextRelease(lastRelease: Date, dbFrequency: string): string {
  if (dbFrequency === 'daily') return 'Daily';
  const daysToAdd =
    dbFrequency === 'quarterly' ? 90 :
    dbFrequency === 'monthly' ? 30 :
    dbFrequency === 'weekly' ? 7 :
    0;
  if (daysToAdd === 0) return '—';
  const next = new Date(lastRelease);
  next.setUTCDate(next.getUTCDate() + daysToAdd);
  return formatDateShort(next);
}

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
// Asset display metadata (hardcoded from frontend demo data)
// ============================================================================

export interface AssetMeta {
  code: string;
  dbCode: string; // asset.code in DB (pairs use pair code, currencies use currency code)
  flag: string;
  type: 'Forex' | 'Commodity' | 'Index';
  name: string;
  currencyCode?: string; // for scorecard: maps key to DB asset code
}

/** The 8 assets shown in the Oracle screener (frontend assets.ts order). */
export const ORACLE_ASSETS: AssetMeta[] = [
  { code: 'EURUSD', dbCode: 'EURUSD', flag: '🇪🇺🇺🇸', type: 'Forex', name: 'EUR/USD' },
  { code: 'GBPUSD', dbCode: 'GBPUSD', flag: '🇬🇧🇺🇸', type: 'Forex', name: 'GBP/USD' },
  { code: 'USDJPY', dbCode: 'USDJPY', flag: '🇺🇸🇯🇵', type: 'Forex', name: 'USD/JPY' },
  { code: 'EURJPY', dbCode: 'EURJPY', flag: '🇪🇺🇯🇵', type: 'Forex', name: 'EUR/JPY' },
  { code: 'GBPJPY', dbCode: 'GBPJPY', flag: '🇬🇧🇯🇵', type: 'Forex', name: 'GBP/JPY' },
  { code: 'XAUUSD', dbCode: 'XAUUSD', flag: '🥇', type: 'Commodity', name: 'Gold' },
  { code: 'SPY', dbCode: 'SPY', flag: '🇺🇸', type: 'Index', name: 'S&P 500 ETF' },
  { code: 'NAS100', dbCode: 'NAS100', flag: '🇺🇸', type: 'Index', name: 'NASDAQ 100' },
];

/** Scorecard key → DB asset code mapping. */
export const SCORECARD_KEY_TO_ASSET_CODE: Record<string, string> = {
  USD: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
  JPY: 'JPY',
  Gold: 'XAUUSD',
  SPY: 'SPY',
  NAS100: 'NAS100',
};

/** Scorecard asset metadata (name, flag). */
export const SCORECARD_ASSET_META: Record<string, { name: string; flag: string }> = {
  USD: { name: 'US Dollar', flag: '🇺🇸' },
  EUR: { name: 'Euro', flag: '🇪🇺' },
  GBP: { name: 'British Pound', flag: '🇬🇧' },
  JPY: { name: 'Japanese Yen', flag: '🇯🇵' },
  Gold: { name: 'Gold (XAUUSD)', flag: '🥇' },
  SPY: { name: 'S&P 500 (SPY)', flag: '📈' },
  NAS100: { name: 'Nasdaq 100', flag: '💻' },
};

/** COT asset display code for each pair (base currency's cot_data asset). */
export const PAIR_COT_CURRENCY: Record<string, string> = {
  EURUSD: 'EUR',
  GBPUSD: 'GBP',
  USDJPY: 'JPY',
  EURJPY: 'EUR',
  GBPJPY: 'GBP',
};

/**
 * Assets shown on the COT (Commitment of Traders) page.
 *
 * COT positioning is reported by the CFTC per **futures contract**, so the rows
 * are the individual instruments we track — the four currency futures + Gold —
 * NOT the forex pairs. cot_data is keyed by the currency/commodity asset code
 * (USD/EUR/GBP/JPY/XAUUSD), which is why iterating the pair-based ORACLE_ASSETS
 * only ever matched XAUUSD. SPY and NAS100 are deferred (no CFTC ingestion yet).
 */
export interface CotAssetMeta {
  code: string;   // display code + React key
  dbCode: string; // asset.code in DB that owns the cot_data / scorecard rows
  flag: string;
  type: 'Currency' | 'Commodity' | 'Index';
  deferred?: boolean;
}

export const COT_ASSETS: CotAssetMeta[] = [
  { code: 'USD', dbCode: 'USD', flag: '🇺🇸', type: 'Currency' },
  { code: 'EUR', dbCode: 'EUR', flag: '🇪🇺', type: 'Currency' },
  { code: 'GBP', dbCode: 'GBP', flag: '🇬🇧', type: 'Currency' },
  { code: 'JPY', dbCode: 'JPY', flag: '🇯🇵', type: 'Currency' },
  { code: 'XAUUSD', dbCode: 'XAUUSD', flag: '🪙', type: 'Commodity' },
  { code: 'SPY', dbCode: 'SPY', flag: '🇺🇸', type: 'Index', deferred: true },
  { code: 'NAS100', dbCode: 'NAS100', flag: '🇺🇸', type: 'Index', deferred: true },
];

/** COT flags per asset in COT table. */
export const COT_ASSET_FLAG: Record<string, string> = {
  EURUSD: '🇪🇺🇺🇸',
  GBPUSD: '🇬🇧🇺🇸',
  USDJPY: '🇺🇸🇯🇵',
  EURJPY: '🇪🇺🇯🇵',
  GBPJPY: '🇬🇧🇯🇵',
  XAUUSD: '🪙',   // cot.ts uses coin emoji
  SPY: '🇺🇸',
  NAS100: '🇺🇸',
};

export const COT_ASSET_TYPE: Record<string, 'Forex' | 'Commodity' | 'Index'> = {
  EURUSD: 'Forex',
  GBPUSD: 'Forex',
  USDJPY: 'Forex',
  EURJPY: 'Forex',
  GBPJPY: 'Forex',
  XAUUSD: 'Commodity',
  SPY: 'Index',
  NAS100: 'Index',
};

// ============================================================================
// Fx pair display metadata
// ============================================================================

export const FX_PAIR_META: Record<string, {
  label: string;
  currAName: string;
  currAFlag: string;
  currBName: string;
  currBFlag: string;
  base: string;
  quote: string;
}> = {
  EURUSD: { label: 'EUR / USD', currAName: 'EUR', currAFlag: '🇪🇺', currBName: 'USD', currBFlag: '🇺🇸', base: 'EUR', quote: 'USD' },
  GBPUSD: { label: 'GBP / USD', currAName: 'GBP', currAFlag: '🇬🇧', currBName: 'USD', currBFlag: '🇺🇸', base: 'GBP', quote: 'USD' },
  USDJPY: { label: 'USD / JPY', currAName: 'USD', currAFlag: '🇺🇸', currBName: 'JPY', currBFlag: '🇯🇵', base: 'USD', quote: 'JPY' },
  EURJPY: { label: 'EUR / JPY', currAName: 'EUR', currAFlag: '🇪🇺', currBName: 'JPY', currBFlag: '🇯🇵', base: 'EUR', quote: 'JPY' },
  GBPJPY: { label: 'GBP / JPY', currAName: 'GBP', currAFlag: '🇬🇧', currBName: 'JPY', currBFlag: '🇯🇵', base: 'GBP', quote: 'JPY' },
};

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

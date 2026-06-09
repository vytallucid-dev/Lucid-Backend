/**
 * Oracle API type definitions — exact match of frontend interfaces.
 * Source of truth: lucid-frontend/src/data/*.ts
 * When spec text and frontend differ, frontend wins (Phase 6 hard rule).
 */

// ============================================================================
// Shared primitives
// ============================================================================

/** Frontend getBias thresholds (from assets.ts getBias function). */
export type BiasType = 'Strong Bullish' | 'Bullish' | 'Neutral' | 'Bearish' | 'Strong Bearish';

export type AssetType = 'Forex' | 'Currency' | 'Commodity' | 'Index';

export type IndicatorValue = 1 | 0 | -1 | null; // null = N/A

export type CotValue = 2 | 1 | 0 | -1 | -2;

// ============================================================================
// AssetData (GET /api/oracle/assets)
// Matches frontend src/data/assets.ts AssetData interface exactly.
// ============================================================================

export interface AssetData {
  asset: string;
  type: AssetType;
  flag: string;
  score: number | null;       // null when deferred or no data
  bias: BiasType | null;      // null when deferred or no data
  cot: CotValue | null;       // null when deferred or no data
  // Economic Growth
  gdp: IndicatorValue;
  pmiM: IndicatorValue;
  pmiS: IndicatorValue;
  retail: IndicatorValue;
  consConf: IndicatorValue;
  // Inflation
  cpi: IndicatorValue;
  ppi: IndicatorValue;
  pce: IndicatorValue;
  yield: IndicatorValue;
  // Jobs Market
  nfp: IndicatorValue;
  unemp: IndicatorValue;
  claims: IndicatorValue;
  adp: IndicatorValue;
  jolts: IndicatorValue;
  outcome: 'scored' | 'insufficient_data' | 'deferred';
  reason: string | null;
  /** ISO date of the latest pair-score/scorecard underlying this row (global max across assets). */
  lastUpdated: string | null;
}

// ============================================================================
// ScorecardAsset (GET /api/oracle/scorecard?asset=USD)
// Matches frontend src/data/scorecard.ts
// ============================================================================

export type ScorecardAssetKey = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'Gold' | 'SPY' | 'NAS100';

export interface ScorecardIndicator {
  name: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  surprise: string | null;
  score: 1 | 0 | -1 | null;
  outcome: 'scored' | 'insufficient_data' | 'stale';
  reason: string | null;
  staleDate?: string;
}

export interface ScorecardSection {
  label: string;
  color: string;
  subtotal: number;
  indicators: ScorecardIndicator[];
}

export interface CotDetail {
  netPositioning: 'Bullish' | 'Bearish' | 'Neutral';
  weeklyChange: 'Bullish' | 'Bearish' | 'Neutral';
  cotScore: number;
  longPct: string;
  shortPct: string;
  deltaWeekly: string;
}

export interface ScorecardAsset {
  key: ScorecardAssetKey;
  name: string;
  flag: string;
  totalScore: number | null;
  fundamentals: number | null;
  cotScore: number | null;
  bias: BiasType | null;
  cot: CotDetail | null;        // entire object null when deferred/no-data
  sections: ScorecardSection[];  // stays array, may be empty
  scoreHistory: number[] | null;
  outcome: 'scored' | 'insufficient_data' | 'deferred';
  reason: string | null;
  /** ISO date of the scorecard's observationDate (when the underlying data is as-of). */
  lastUpdated: string | null;
}

// ============================================================================
// CotAsset (GET /api/oracle/cot)
// Matches frontend src/data/cot.ts
// ============================================================================

export type CotScore = 2 | 1 | 0 | -1 | -2;

export interface CotAsset {
  asset: string;
  flag: string;
  type: AssetType;
  longContracts: number | null;
  shortContracts: number | null;
  deltaLong: number | null;
  deltaShort: number | null;
  longPct: number | null;
  shortPct: number | null;
  netPctChange: number | null;
  netPosition: number | null;
  cotScore: CotScore | null;
  scoreTooltip: string;
  trend: number[] | null; // 4-week history of netPctChange; null when no COT data
  outcome: 'scored' | 'insufficient_data' | 'deferred';
  reason: string | null;
  /** Latest CFTC report date across all assets (ISO date). "Data as of". */
  dataAsOf: string | null;
  /** Friday the latest report was published (ISO date). "Released". */
  releasedOn: string | null;
}

// ============================================================================
// HeatmapIndicator (GET /api/oracle/heatmap)
// Matches frontend src/data/heatmap.ts
// ============================================================================

export type EconomyKey = 'US' | 'EU' | 'UK' | 'JP';
export type HeatmapFrequency = 'Monthly' | 'Quarterly' | 'Weekly' | 'Daily';

export interface HeatmapIndicator {
  name: string;
  frequency: HeatmapFrequency;
  category: 'ECONOMIC GROWTH' | 'INFLATION' | 'JOBS MARKET';
  lastRelease: string;  // "Mar 27, 2026" or "Daily"
  nextRelease: string;  // "Jun 26, 2026" or "Daily" or "—"
  actual: string | null;     // null when insufficient_data
  forecast: string | null;   // null when insufficient_data or no forecast
  previous: string | null;   // null when insufficient_data
  surprise: string | null;   // null when insufficient_data or no forecast
  score: 1 | 0 | -1 | null; // null when insufficient_data
  outcome: 'scored' | 'insufficient_data' | 'stale';
  reason: string | null;
  stale?: boolean;
}

export type HeatmapResponse = Record<EconomyKey, HeatmapIndicator[]>;

// ============================================================================
// FxPairData (GET /api/oracle/fx-scorecard)
// Matches frontend src/data/fx-scorecard.ts
// ============================================================================

export type FxPairKey = 'EURUSD' | 'GBPUSD' | 'USDJPY' | 'EURJPY' | 'GBPJPY';
export type ResultTag = 'BEAT' | 'MISS' | 'MET' | 'N/A';

export interface FxIndicatorRow {
  name: string;
  frequency?: string;
  currA: {
    result: ResultTag;
    actual: string | null;      // null when N/A
    forecast?: string | null;
    surprise?: string | null;
    outcome: 'scored' | 'insufficient_data';
  };
  currB: {
    result: ResultTag;
    actual: string | null;      // null when N/A
    forecast?: string | null;
    surprise?: string | null;
    outcome: 'scored' | 'insufficient_data';
  };
  pairScore: number | null; // null = excluded from scoring
}

export interface FxCategoryCard {
  label: string;
  color: string;
  subtotal: number;
  indicators: FxIndicatorRow[];
}

export interface FxCotSide {
  longPct: string;
  shortPct: string;
  changePct: string;   // NOTE: frontend uses changePct (not deltaWeekly)
  direction: 'Bullish' | 'Bearish' | 'Neutral';
}

export interface FxPairData {
  key: FxPairKey;
  label: string;
  currAName: string;
  currAFlag: string;
  currBName: string;
  currBFlag: string;
  totalScore: number | null;
  fundamentals: number | null;
  cotScore: number | null;
  bias: BiasType | null;
  cotA: FxCotSide | null;
  cotB: FxCotSide | null;
  cotNote: string | null;
  categories: FxCategoryCard[]; // NOTE: frontend uses categories (not sections)
  scoreHistory: number[] | null;
  outcome: 'scored' | 'insufficient_data';
  reason: string | null;
  /** ISO date of the pair score's scoreDate (when the underlying data is as-of). */
  lastUpdated: string | null;
}

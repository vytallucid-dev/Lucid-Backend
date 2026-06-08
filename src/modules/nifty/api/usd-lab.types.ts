/**
 * USD Lab API types — the transparent breakdown of NIFTY Indicator 9
 * (USD Weakness composite of 14 US macro sub-indicators).
 *
 * Everything here is COMPUTED from the 14 sub-indicators persisted by the
 * ind9 bridge (data_points.sourceMetadata for IND_NIFTY_09_USD_WEAKNESS), so
 * the page is internally self-consistent: the raw composite, the 5-tier score,
 * the cluster math and the composition flag all derive from the same array.
 */

export type Ind9Category =
  | 'Absolute Threshold'
  | 'vs Forecast'
  | 'Direction vs Prior'
  | 'Direction vs Prior (INVERTED)'
  | 'SMA Direction';

export type Ind9Cluster = 'INFLATION' | 'GROWTH' | 'LABOR' | 'SENTIMENT';

/** USD-strength convention: +1 = USD strong, -1 = USD weak, 0 = neutral. */
export type Ind9SubScore = -1 | 0 | 1 | null;

export type Ind9Cadence = 'Daily' | 'Weekly' | 'Monthly' | 'Quarterly';

export type Ind9CompositionFlag =
  | 'INFLATION_LED'
  | 'DEMAND_DESTRUCTION'
  | 'MIXED'
  | 'INFLATION_HOT'
  | 'DEMAND_REACCEL'
  | 'MIXED_HOT'
  | null;

export interface UsdLabSubIndicator {
  id: number; // 1-14, ordered for display
  code: string; // e.g. 'US_GDP_QOQ'
  name: string; // 'GDP QoQ'
  short: string; // 'GDP'
  category: Ind9Category;
  cluster: Ind9Cluster;
  score: Ind9SubScore; // USD-strength
  /** Display-formatted current reading, e.g. '2.4%', '54.0', '+172K'. */
  actual: string | null;
  /** Display-formatted forecast (vs Forecast indicators). */
  forecast: string | null;
  /** Display-formatted prior (Direction vs Prior indicators). */
  prior: string | null;
  /** Display-formatted threshold (Absolute Threshold indicators), e.g. '50.0'. */
  threshold: string | null;
  /** The reference value actually used for scoring + how to label it. */
  reference: string | null;
  referenceKind: 'forecast' | 'prior' | 'threshold' | 'sma_5d' | 'none';
  /** One-line rationale, e.g. 'Actual 2.4% < Forecast 2.5% → −1 (USD weak)'. */
  reasoning: string;
  lastReleaseDate: string | null; // ISO yyyy-mm-dd
  cadence: Ind9Cadence;
  dataSource: string; // display label, e.g. 'Forex Factory', 'FRED'
  isStale: boolean;
  staleDays: number | null;
  /** vs Forecast indicator fell back to prior because forecast was missing. */
  fallbackUsed: boolean;
}

export interface UsdLabTier {
  min: number | null; // inclusive lower bound (null = -inf)
  max: number | null; // inclusive upper bound (null = +inf)
  niftyScore: number; // -2..+2
  read: string; // 'weak USD', etc.
  current: boolean;
}

export interface UsdLabCluster {
  cluster: Ind9Cluster;
  sum: number;
  negCount: number;
  posCount: number;
  includedInFlag: boolean;
}

export interface UsdLabFlagCheck {
  flag: Exclude<Ind9CompositionFlag, null>;
  passed: boolean;
  detail: string;
}

export interface UsdLabComposition {
  flag: Ind9CompositionFlag;
  activated: boolean;
  side: 'weak' | 'strong' | null; // which side of the mirror
  iNeg: number;
  glNeg: number;
  iPos: number;
  glPos: number;
  checks: UsdLabFlagCheck[];
  read: string; // operational read for the resolved flag
}

export interface UsdLabHistoryPoint {
  date: string; // ISO yyyy-mm-dd
  rawComposite: number;
  niftyScore: number; // -2..+2
  compositionFlag: Ind9CompositionFlag;
}

export type UsdLabComputability = 'FULL' | 'DEGRADED' | 'SUPPRESSED';

export interface UsdLabDataQuality {
  dataCount: number; // of 14 with a reading
  parseableCount: number; // of 14 that produced a score
  staleCount: number;
  computability: UsdLabComputability;
  suppressed: boolean;
}

export interface UsdLabResponse {
  asOf: string; // ISO yyyy-mm-dd (scorecard observation date)
  rawComposite: number | null; // -14..+14
  niftyScore: number | null; // -2..+2 (NIFTY-facing, sign-flipped)
  tiers: UsdLabTier[];
  composition: UsdLabComposition;
  subIndicators: UsdLabSubIndicator[];
  clusters: UsdLabCluster[];
  history: UsdLabHistoryPoint[];
  dataQuality: UsdLabDataQuality;
}

// ─── Sub-indicator detail (drawer) ────────────────────────────────────────────

export interface UsdLabReleaseRow {
  date: string; // ISO yyyy-mm-dd
  actual: string | null;
  reference: string | null;
  referenceKind: 'forecast' | 'prior' | 'threshold' | 'sma_5d' | 'none';
  score: Ind9SubScore;
}

export interface UsdLabSubIndicatorDetail {
  code: string;
  name: string;
  short: string;
  category: Ind9Category;
  cluster: Ind9Cluster;
  cadence: Ind9Cadence;
  dataSource: string;
  releases: UsdLabReleaseRow[]; // newest first, up to 12
}

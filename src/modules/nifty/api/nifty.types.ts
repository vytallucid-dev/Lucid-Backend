/**
 * NIFTY Public API types — exact match of frontend nifty-demo-data.ts interfaces.
 * Source of truth: lucid-frontend/src/lib/nifty-demo-data.ts
 */

export type NiftyBand =
  | 'Strong Bullish'
  | 'Bullish'
  | 'Neutral'
  | 'Caution'
  | 'Bearish'
  | 'Strong Bearish';

export type NiftyCompositionFlag =
  | 'INFLATION_LED'
  | 'DEMAND_DESTRUCTION'
  | 'MIXED'
  | 'INFLATION_HOT'
  | 'DEMAND_REACCEL'
  | null;

export type NiftyRegimeBucket = 'BULL' | 'BEAR_DEEP' | 'BEAR_LIGHT' | 'TOP_CORRECTION' | 'MIXED';

export type NiftyIndicatorScore = -2 | -1 | 0 | 1 | 2;

export type NiftyComposite = 'Domestic' | 'External';

export type NiftyPatternTier = 'CONFIRMED' | 'OBSERVED' | 'HYPOTHESIS';

/** Frontend Indicator — no code/outcome/flags fields. */
export interface NiftyIndicator {
  id: number;
  name: string;
  short: string;
  composite: NiftyComposite;
  score: NiftyIndicatorScore;
  value: string;
  magnitude: string;
  trajectory_3m_avg?: string;
  last_change_date: string;
  prev_score?: NiftyIndicatorScore;
}

/** Full scorecard — matches frontend Scorecard type. */
export interface NiftyScorecard {
  id: string;
  date: string;
  phase?: string;
  bucket?: NiftyRegimeBucket;
  indicators: NiftyIndicator[];
  domestic_composite: number;
  external_composite: number;
  net_score: number;
  band: NiftyBand;
  ind9_raw_composite: number | null;
  ind9_sub_indicators: Record<string, NiftyIndicatorScore>;
  composition_flag: NiftyCompositionFlag;
  peak_score_active: boolean;
  peak_score_peak_date?: string;
  peak_score_peak_value?: number;
  velocity_short?: number;
  conflict_flag: boolean;
  notes?: string;
  catalysts: string[];
}

/** Lightweight history item — no indicators array. */
export interface NiftyScorecardHistoryItem {
  id: string;
  date: string;
  net_score: number;
  domestic_composite: number;
  external_composite: number;
  band: NiftyBand;
  conflict_flag: boolean;
  composition_flag: NiftyCompositionFlag;
  peak_score_active: boolean;
  ind9_raw_composite: number | null;
}

export interface NiftyPattern {
  id: string;
  name: string;
  tier: NiftyPatternTier;
  category: 'Peak/Trough' | 'Composite' | 'Bear Regime' | 'Recovery' | 'Operational' | 'Structural';
  instances: number;
  rule: string;
  example_dates: string[];
  description: string;
  drives_subtool?: 'Velocity' | 'Peak Ceiling' | 'V-Bottom' | 'Composition' | 'Section 9F';
  status: string;
  relevance_triggers: string[];
}

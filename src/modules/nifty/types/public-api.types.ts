/**
 * Public API types for the NIFTY frontend. Field names use snake_case
 * to match the frontend's existing TypeScript interfaces exactly. This is a
 * deliberate departure from the rest of the codebase's camelCase convention
 * — it eliminates frontend translation logic.
 *
 * Reference: lucid-frontend/src/lib/nifty-demo-data.ts lines 3-145
 */

export type PublicBand =
  | 'Strong Bullish'
  | 'Bullish'
  | 'Neutral'
  | 'Caution'
  | 'Bearish'
  | 'Strong Bearish';

export type PublicCompositionFlag =
  | 'INFLATION_LED'
  | 'DEMAND_DESTRUCTION'
  | 'MIXED'
  | 'INFLATION_HOT'
  | 'DEMAND_REACCEL'
  | null;

export type PublicComposite = 'Domestic' | 'External';

export type PublicIndicatorScore = -2 | -1 | 0 | 1 | 2;

export type PublicRegimeBucket =
  | 'BULL'
  | 'BEAR_DEEP'
  | 'BEAR_LIGHT'
  | 'TOP_CORRECTION'
  | 'MIXED';

export interface PublicIndicator {
  id: number; // 1-13 (from displayOrder)
  code: string; // 'IND_NIFTY_01_PMI_MFG'
  name: string; // 'PMI Manufacturing'
  short: string; // 'PMI Mfg'
  composite: PublicComposite;
  score: PublicIndicatorScore | null;
  value: string; // pre-formatted display string e.g. '54.6', '₹2.10T', 'Raw -6'
  magnitude: string; // narrative context line e.g. 'vs prior 3.40%'
  trajectory_3m_avg?: string; // only set for Ind 3 (India CPI)
  last_change_date: string; // ISO 'YYYY-MM-DD'
  prev_score?: PublicIndicatorScore;
  outcome: 'scored' | 'carry_forward' | 'insufficient_data';
  flags: string[];
  reason?: string; // only set when outcome is insufficient_data
}

export interface PublicScorecard {
  id: string; // scorecard UUID
  date: string; // ISO 'YYYY-MM-DD'
  phase?: string; // analyst-supplied, undefined for v1
  bucket?: PublicRegimeBucket; // analyst-supplied, undefined for v1
  indicators: PublicIndicator[]; // exactly 13, in id order 1..13
  domestic_composite: number;
  external_composite: number;
  net_score: number;
  band: PublicBand;
  ind9_raw_composite: number | null;
  ind9_sub_indicators: Record<string, PublicIndicatorScore>; // empty object until EdgeFinder
  composition_flag: PublicCompositionFlag;
  peak_score_active: boolean;
  peak_score_peak_date?: string;
  peak_score_peak_value?: number;
  velocity_short?: number;
  conflict_flag: boolean;
  notes?: string;
  catalysts: string[]; // empty array until analyst-supplied
  missing_indicators: string[]; // indicator codes that returned insufficient_data
}

export interface PublicScorecardHistoryItem {
  // Lightweight scorecard for history list views (no indicators array)
  id: string;
  date: string;
  net_score: number;
  domestic_composite: number;
  external_composite: number;
  band: PublicBand;
  conflict_flag: boolean;
  composition_flag: PublicCompositionFlag;
  peak_score_active: boolean;
  ind9_raw_composite: number | null;
}

export interface PublicIndicatorMetadata {
  id: number;
  code: string;
  name: string;
  short: string;
  composite: PublicComposite;
  output_range: string; // e.g. '-2/-1/0/+1/+2' or '-1/0/+1'
  cadence: string; // 'daily', 'monthly', 'event_driven'
  data_source: string; // 'fred', 'manual', 'nse_scrape', 'derived'
  unit: string | null;
  description: string | null;
  last_updated: string | null; // ISO date of most recent data point
  is_active: boolean;
}

export interface PublicIndicatorDetail extends PublicIndicatorMetadata {
  latest_score: PublicIndicatorScore | null;
  latest_value: string | null;
  latest_value_raw: number | null;
  latest_observation_date: string | null;
  recent_scores?: Array<{
    date: string;
    score: PublicIndicatorScore;
    value: string;
    flags: string[];
  }>;
  recent_data_points?: Array<{
    date: string;
    value: number;
    source: string;
    is_revised: boolean;
  }>;
}

export interface PublicAdminLogEntry {
  id: string;
  jobName: string;
  triggerType: string;
  triggeredBy: string | null;
  status: string;
  startedAt: string; // ISO datetime
  completedAt: string | null;
  durationMs: number | null;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  targetDateFrom: string | null;
  targetDateTo: string | null;
  metadata: Record<string, unknown> | null;
  errors: unknown[] | null;
}

export interface PublicAdminLogsResponse {
  totalCount: number;
  limit: number;
  offset: number;
  logs: PublicAdminLogEntry[];
}

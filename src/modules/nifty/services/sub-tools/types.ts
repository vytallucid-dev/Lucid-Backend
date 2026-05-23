import { Prisma } from '@prisma/client';

export type VelocityLabel =
  | 'Emergency Deterioration'
  | 'Warning'
  | 'Alert'
  | 'Mild Deterioration'
  | 'Flat'
  | 'Slow Repair'
  | 'Fast Repair'
  | 'Ceiling Recovery';

export type DecayTier = 'PASSIVE' | 'ACTIVE' | 'SHARP';

export type EntryReason = 'plus_10' | 'plus_9_120d_high';

export type PeakScoreCeilingState =
  | { status: 'inactive' }
  | {
      status: 'active';
      peakDate: string;
      peakNetScore: number;
      entryReason: EntryReason;
      sessionsSincePeak: number;
      currentNetScore: number;
      decayPerDay: number;
      decayTier: DecayTier;
      pendingDeactivation: boolean;
      sessionsBelowThreshold: number;
    };

export type CompositionFlag =
  | 'INFLATION_LED'
  | 'DEMAND_DESTRUCTION'
  | 'MIXED'
  | 'INFLATION_HOT'
  | 'DEMAND_REACCEL';

export type VBottomClassification =
  | 'REAL_V_BOTTOM'
  | 'AMBIGUOUS'
  | 'COUNTER_TREND_BOUNCE';

export interface ScorecardHistoryRow {
  observationDate: Date;
  netScore: number;
  peakScoreCeilingState: Prisma.JsonValue | null;
}

export interface VelocityResult {
  velocity: number | null;
  label: VelocityLabel | null;
  sessions: number | null;
  startDate: string | null;
  endDate: string | null;
  startNet: number | null;
  endNet: number | null;
  reason?: string;
}

export interface AutoAnchors {
  highAnchorDate: string | null;
  highAnchorNet: number | null;
  lowAnchorDate: string | null;
  lowAnchorNet: number | null;
  defaultStartDate: string | null;
  defaultStartNet: number | null;
}

export interface VBottomExample {
  date: string;
  description: string;
  rawAtTrough: number;
  outcome: string;
}

export interface VBottomResult {
  date: string;
  ind9Raw: number | null;
  classification: VBottomClassification | null;
  forwardExpectation: string;
  examples: VBottomExample[];
}

import type { ColorBand } from '../compass-bands';

/**
 * Layer 1 / layer 2 shared types.
 *
 * THE CORE CONSTRAINT, restated here because it is easy to erode:
 * a reading has two INDEPENDENT axes. `colorBand`/`isVoting`/`weight` is the
 * vote; `stateLabel` is a description that carries no opinion about risk
 * appetite. Nothing that computes a vote may read `stateLabel`, and nothing that
 * describes state may read `colorBand`.
 *
 * That is what lets a future "repricing regime" reading exist — the 2022 case,
 * which this classifier is structurally unable to register as risk — without a
 * migration and without touching scoring.
 */

export const MODULE_CODES = [
  'YIELDS',
  'VOL_CREDIT',
  'ECON_DATA',
  'DOLLAR_POSITIONING',
  'POLICY_STANCE',
] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];

export const MODULE_TITLES: Record<ModuleCode, string> = {
  YIELDS: 'Yields',
  VOL_CREDIT: 'Volatility & Credit',
  ECON_DATA: 'Economic Data',
  DOLLAR_POSITIONING: 'Dollar & Positioning',
  POLICY_STANCE: 'Policy Stance',
};

/**
 * Freshness of the underlying observation.
 *   FRESH   a real observation for this date
 *   FILLED  carried forward from an earlier real observation, within limit
 *   STALE   carried forward BEYOND its configured limit — do not trust
 *   MISSING no observation at all (including "the series does not exist yet")
 */
export type StalenessState = 'FRESH' | 'FILLED' | 'STALE' | 'MISSING';

export interface ExplanationRef {
  templateId: string;
  params: Record<string, string | number | boolean | null>;
}

export interface ModuleReading {
  moduleCode: ModuleCode;
  readingCode: string;
  /** Human label for the UI. */
  title: string;

  // --- vote axis (all null/false for a non-voting reading) ---
  colorBand: ColorBand | null;
  isVoting: boolean;
  weight: number | null;

  // --- state axis: describes without judging ---
  stateLabel: string | null;

  // --- value ---
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;

  // --- provenance, mandatory ---
  sourceCode: string;
  sourceAsOf: Date | null;
  stalenessState: StalenessState;
  stalenessDays: number | null;

  explanation: ExplanationRef | null;
}

export interface ModuleState {
  moduleCode: ModuleCode;
  /** Null for a module that does not vote. Policy Stance never votes. */
  verdictBand: ColorBand | null;
  stateLabel: string | null;
  headline: ExplanationRef;
  readingCodes: string[];
}

export interface SentenceTrace {
  moduleCode: ModuleCode;
  readingCode: string;
}

export interface Sentence {
  templateId: string;
  params: Record<string, string | number | boolean | null>;
  text: string;
  /**
   * At least one, and every one must resolve to a reading present for the same
   * date. A synthesis claim with no supporting module reading is a bug and is
   * caught by a test rather than rendered.
   */
  traces: SentenceTrace[];
}

export interface Synthesis {
  sentences: Sentence[];
  /** Module conflict is surfaced, never averaged away. */
  disagreements: Sentence[];
}

/** Everything layer 2 is allowed to see. */
export interface ModuleBundle {
  classificationDate: Date;
  readings: ModuleReading[];
  states: ModuleState[];
}

export function findReading(
  bundle: Pick<ModuleBundle, 'readings'>,
  readingCode: string,
): ModuleReading | undefined {
  return bundle.readings.find((r) => r.readingCode === readingCode);
}

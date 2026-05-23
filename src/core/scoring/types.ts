export type Score = -2 | -1 | 0 | 1 | 2;

export interface ScoredResult {
  kind: 'scored';
  score: Score;
  flags: string[];
  metadata: Record<string, unknown>;
}

export interface InsufficientDataResult {
  kind: 'insufficient_data';
  reason: string;
  details?: Record<string, unknown>;
}

export interface CarryForwardResult {
  kind: 'carry_forward';
  score: Score;
  sourceDate: Date;
  daysStale: number;
  flags: string[];
  metadata: Record<string, unknown>;
}

export type ScoringResult = ScoredResult | InsufficientDataResult | CarryForwardResult;

export interface ScoringContext {
  indicatorId: string;
  indicatorCode: string;
  observationDate: Date;
  ruleVersionId: string;
  ruleDefinition: Record<string, unknown>;
}

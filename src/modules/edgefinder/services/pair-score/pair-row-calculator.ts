import type { Currency, PairRowConfig } from './pair-template.config';

export interface IndicatorScoreSnapshot {
  indicatorCode: string;
  score: number;
  direction: string | null;
  outcome: 'scored' | 'insufficient_data' | 'carry_forward';
}

export interface PairRowSideBreakdown {
  code: string | null;
  score: number;
  direction: string | null;
  inverted: boolean;
  outcome: 'scored' | 'insufficient_data' | 'carry_forward' | 'absent';
}

export interface PairRowResult {
  rowName: string;
  uiGroup: string;
  indicatorA: PairRowSideBreakdown;
  indicatorB: PairRowSideBreakdown;
  pairScore: number;
  notes: string | null;
  rowIncluded: boolean;
}

export function getEffectiveScore(rawScore: number, isInverted: boolean): number {
  return isInverted ? -rawScore : rawScore;
}

function clampToPairRange(n: number): number {
  if (n > 2) return 2;
  if (n < -2) return -2;
  return n;
}

interface EvaluatePairRowInput {
  config: PairRowConfig;
  baseCurrency: Currency;
  quoteCurrency: Currency;
  baseScore: IndicatorScoreSnapshot | null;
  quoteScore: IndicatorScoreSnapshot | null;
}

/**
 * Rows that are hard-excluded from a pair's template when their required
 * currency is absent. These rows are not part of the pair's template at all
 * (rowIncluded=false). All other rows with `requiresCurrency` are kept in
 * the template but force-scored to 0 with an explanatory note when the
 * required currency is absent.
 *
 * - Household Spending is JPY-specific and only appears in JPY pairs.
 * - PPI stays in every pair's template per Rule B (scores 0 in non-EUR pairs).
 * - USD-only rows (PCE, NFP, JOLTS, ADP, Jobless Claims) stay in every pair's
 *   template; in non-USD pairs both sides are absent so the row scores 0
 *   naturally.
 */
const HARD_EXCLUDE_WHEN_REQUIREMENT_UNSATISFIED = new Set(['Household Spending']);

/**
 * Evaluate one pair-template row given the two sides' indicator snapshots.
 *
 * - `requiresCurrency` filter:
 *     • If the required currency is in the pair → row scores normally.
 *     • If absent AND row name is in HARD_EXCLUDE_WHEN_REQUIREMENT_UNSATISFIED
 *       → rowIncluded=false (row is not part of this pair's template).
 *     • If absent otherwise → rowIncluded=true, pairScore forced to 0 with a
 *       note (e.g., PPI in non-EUR pairs, USD-only rows in EURJPY/GBPJPY).
 * - Per-currency inversion is applied to each side independently.
 * - Missing config entry (no indicator for a currency) → that side = 0,
 *   outcome 'absent'.
 * - `insufficient_data` outcome → that side counts as 0 in the math but
 *   retains its outcome for the breakdown.
 */
export function evaluatePairRow(input: EvaluatePairRowInput): PairRowResult {
  const { config, baseCurrency, quoteCurrency, baseScore, quoteScore } = input;

  const baseIndicatorCode = config.indicators[baseCurrency] ?? null;
  const quoteIndicatorCode = config.indicators[quoteCurrency] ?? null;
  const baseInverted = config.inverted?.[baseCurrency] === true;
  const quoteInverted = config.inverted?.[quoteCurrency] === true;

  const requires = config.requiresCurrency;
  const requirementSatisfied =
    !requires ||
    requires.includes(baseCurrency) ||
    requires.includes(quoteCurrency);

  const baseSide: PairRowSideBreakdown = {
    code: baseIndicatorCode,
    score: 0,
    direction: null,
    inverted: baseInverted,
    outcome: baseIndicatorCode === null ? 'absent' : 'scored',
  };
  const quoteSide: PairRowSideBreakdown = {
    code: quoteIndicatorCode,
    score: 0,
    direction: null,
    inverted: quoteInverted,
    outcome: quoteIndicatorCode === null ? 'absent' : 'scored',
  };

  if (baseScore !== null && baseIndicatorCode !== null) {
    baseSide.score = baseScore.score;
    baseSide.direction = baseScore.direction;
    baseSide.outcome = baseScore.outcome;
  }
  if (quoteScore !== null && quoteIndicatorCode !== null) {
    quoteSide.score = quoteScore.score;
    quoteSide.direction = quoteScore.direction;
    quoteSide.outcome = quoteScore.outcome;
  }

  if (!requirementSatisfied) {
    const requiredLabel = requires?.join('/') ?? '';
    if (HARD_EXCLUDE_WHEN_REQUIREMENT_UNSATISFIED.has(config.rowName)) {
      return {
        rowName: config.rowName,
        uiGroup: config.uiGroup,
        indicatorA: baseSide,
        indicatorB: quoteSide,
        pairScore: 0,
        notes: `${config.rowName} not in this pair's template — requires ${requiredLabel}`,
        rowIncluded: false,
      };
    }
    return {
      rowName: config.rowName,
      uiGroup: config.uiGroup,
      indicatorA: baseSide,
      indicatorB: quoteSide,
      pairScore: 0,
      notes: `${config.rowName} excluded from non-${requiredLabel} pair scoring per spec`,
      rowIncluded: true,
    };
  }

  const effectiveBase =
    baseSide.outcome === 'insufficient_data'
      ? 0
      : getEffectiveScore(baseSide.score, baseInverted);
  const effectiveQuote =
    quoteSide.outcome === 'insufficient_data'
      ? 0
      : getEffectiveScore(quoteSide.score, quoteInverted);

  const pairScore = clampToPairRange(effectiveBase - effectiveQuote);

  const noteParts: string[] = [];
  if (baseInverted) {
    noteParts.push(
      `${baseCurrency} ${config.rowName} inverted: raw ${baseSide.score} → ${effectiveBase}`,
    );
  }
  if (quoteInverted) {
    noteParts.push(
      `${quoteCurrency} ${config.rowName} inverted: raw ${quoteSide.score} → ${effectiveQuote}`,
    );
  }
  if (baseSide.outcome === 'insufficient_data') {
    noteParts.push(`${baseCurrency} side insufficient_data — treated as 0`);
  }
  if (quoteSide.outcome === 'insufficient_data') {
    noteParts.push(`${quoteCurrency} side insufficient_data — treated as 0`);
  }

  return {
    rowName: config.rowName,
    uiGroup: config.uiGroup,
    indicatorA: baseSide,
    indicatorB: quoteSide,
    pairScore,
    notes: noteParts.length > 0 ? noteParts.join('; ') : null,
    rowIncluded: true,
  };
}

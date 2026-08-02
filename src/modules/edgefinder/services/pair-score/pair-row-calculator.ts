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
 * Evaluate one pair-template row given the two sides' indicator snapshots.
 *
 * - Applicability:
 *     • Single-currency rows (`requiresCurrency.length === 1`, e.g. the
 *       USD-only PCE/NFP-style rows) apply when EITHER side is the required
 *       currency — these are intentionally one-sided injections of a single
 *       currency's data into any pair containing it.
 *     • Multi-currency ("bilateral") rows (`requiresCurrency.length > 1`)
 *       require BOTH sides to be in `requiresCurrency`. Every such row
 *       historically had full coverage across all supported currencies, so
 *       this was equivalent to the single-currency OR check — until Phase 6
 *       retired AUD's Retail Sales cell, leaving RETAIL mapped for only 4 of
 *       5 currencies. Under OR semantics that row stayed included for every
 *       AUD pair (since the non-AUD leg still satisfied the check) and
 *       silently degraded into a one-sided contribution instead of being
 *       excluded. AND semantics correctly exclude it for AUD pairs while
 *       remaining a no-op for every fully-covered bilateral row.
 * - When a row does NOT apply, the row's own `softExcludeWhenUnsupported`
 *   property decides what happens. This replaced a hardcoded row-name list, so
 *   a new single-side row behaves correctly without a code change:
 *     • false → rowIncluded=false. The row is not part of this pair's template
 *       (Household Spending, Labor Cash Earnings, Tokyo Core CPI,
 *       AU Employment Change, China Caixin).
 *     • true  → rowIncluded=true with pairScore forced to 0 and a note — the
 *       legacy "dead" USD-only rows in pairs containing no USD.
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
    (requires.length === 1
      ? requires.includes(baseCurrency) || requires.includes(quoteCurrency)
      : requires.includes(baseCurrency) && requires.includes(quoteCurrency));

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
    if (!config.softExcludeWhenUnsupported) {
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

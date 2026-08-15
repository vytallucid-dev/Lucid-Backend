// ─────────────────────────────────────────────────────────────────────────────
// Derived trade metrics: total pips and realised R:R, computed server-side from
// the prices so the journal always shows internally-consistent numbers
// regardless of client input.
//
// P&L IS NOT DERIVED. It is entered by hand and stored verbatim. A price-
// derived figure ignores spread, swap and commission, so it never matched the
// broker statement and was not trusted — the calculator that produced it has
// been removed rather than left in as a fallback that silently fills the field.
//
// Removing it also removed R:R's dependence on money: R is
//   blendedPnl / riskMoney
//     = (totalPips × pipValue × lotSize) / (riskPips × pipValue × lotSize)
//     = totalPips / riskPips
// so pip value and lot size cancel exactly. R is therefore computed from prices
// alone, needs no pair lookup, and stays comparable across accounts of
// different sizes — which is what makes it the right unit for edge statistics.
// Lot size remains stored and shown; it simply no longer feeds this math.
//
// Conventions mirror the frontend's getDistanceToEntry pip sizing so "pips" are
// consistent across the whole app (planned-trade distance badge ↔ journal pips).
// ─────────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Price-units → quote-units multiplier.
 *
 * Forex pairs are quoted in pips: 0.0001, or 0.01 when the quote side is JPY.
 * Everything else — indices, metals — is quoted in whole points, so the
 * multiplier is 1 and a 4500 → 4600 move reads as 100, not 1,000,000.
 *
 * Whether a symbol is a forex pair is decided by the caller from the asset
 * registry (see instrument-scale.ts), not guessed from the symbol here: the
 * old rule special-cased XAU by name and silently treated every index as a
 * 4-decimal FX pair, which is what produced SPY totals like −800,000.
 */
export function pipMultiplier(symbol: string, isForexPair: boolean): number {
  if (!isForexPair) return 1;
  return symbol.toUpperCase().endsWith('JPY') ? 100 : 10000;
}

export interface TradeMetricsInput {
  direction: 'Buy' | 'Sell';
  symbol: string;
  /** Forex ⇒ measured in pips. Anything else ⇒ measured in whole points. */
  isForexPair: boolean;
  entryPrice: number;
  slPrice: number;
  mainExitPrice: number | null;
  partialExitPrice: number | null;
  partialExitLotPct: number | null;
}

export interface TradeMetrics {
  totalPips: number;
  blendedRr: number;
}

/**
 * Computes the price distance and realised R for a closed trade. Returns zeros
 * for a live trade (no main exit yet). Partial exits are blended by lot
 * weighting. Risk is measured against the idea's stop.
 *
 * `totalPips` is pips for forex and whole points for everything else — the unit
 * the instrument is actually quoted in. R is unaffected either way: the
 * multiplier appears in both halves of totalPips / riskPips and cancels.
 */
export function computeTradeMetrics(input: TradeMetricsInput): TradeMetrics {
  if (input.mainExitPrice == null) {
    return { totalPips: 0, blendedRr: 0 };
  }

  const mult = pipMultiplier(input.symbol, input.isForexPair);
  const sign = input.direction === 'Buy' ? 1 : -1;
  const legPips = (exit: number): number => sign * (exit - input.entryPrice) * mult;

  let totalPips: number;
  if (
    input.partialExitPrice != null &&
    input.partialExitLotPct != null &&
    input.partialExitLotPct > 0
  ) {
    const pFrac = Math.min(Math.max(input.partialExitLotPct, 0), 100) / 100;
    const mFrac = 1 - pFrac;
    totalPips = legPips(input.partialExitPrice) * pFrac + legPips(input.mainExitPrice) * mFrac;
  } else {
    totalPips = legPips(input.mainExitPrice);
  }

  const riskPips = Math.abs(input.entryPrice - input.slPrice) * mult;
  const blendedRr = riskPips > 0 ? totalPips / riskPips : 0;

  return {
    totalPips: round2(totalPips),
    blendedRr: round2(blendedRr),
  };
}

/**
 * Expected R:R for the idea — the reward the plan was aiming at, per unit of
 * planned risk, signed the same way realised R is.
 *
 * Null when the plan cannot express a ratio: no target, or a stop sitting
 * exactly on entry (zero risk). Never guessed. A target on the wrong side of
 * entry yields a negative number rather than null — that is a real, and
 * informative, property of the plan as it was recorded.
 */
export function computeExpectedRr(input: {
  direction: string;
  entryPrice: number;
  slPrice: number;
  targetPrice: number | null;
}): number | null {
  if (input.targetPrice == null) return null;
  const risk = Math.abs(input.entryPrice - input.slPrice);
  if (risk === 0) return null;
  const sign = input.direction === 'Buy' ? 1 : -1;
  const reward = sign * (input.targetPrice - input.entryPrice);
  return round2(reward / risk);
}

/**
 * Auto-tags the trading session from the open time (IST clock), mirroring the
 * frontend's getSessionFromTime so sessions match what the UI would derive.
 */
export function sessionFromDate(d: Date): string {
  const istHours = d.getUTCHours() + d.getUTCMinutes() / 60 + 5.5;
  const adjusted = istHours >= 24 ? istHours - 24 : istHours;
  if (adjusted >= 5.5 && adjusted < 11.5) return 'Asian';
  if (adjusted >= 13.5 && adjusted < 17.5) return 'London';
  if (adjusted >= 17.5 && adjusted < 21.5) return 'London-NY Overlap';
  return 'New York';
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived trade metrics: total pips, blended P&L and blended R:R are computed
// server-side from the prices, lot size and the pair's pip value so the journal
// always shows internally-consistent numbers regardless of client input.
//
// Conventions mirror the frontend's getDistanceToEntry pip sizing so "pips" are
// consistent across the whole app (planned-trade distance badge ↔ journal pips).
// ─────────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Price-units → pips multiplier. Gold = 1, JPY pairs = 100, everything else = 10000. */
export function pipMultiplierForSymbol(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes('XAU') || s === 'GOLD') return 1;
  if (s.endsWith('JPY')) return 100;
  return 10000;
}

export interface TradeMetricsInput {
  direction: 'Buy' | 'Sell';
  symbol: string;
  entryPrice: number;
  slPrice: number;
  mainExitPrice: number | null;
  partialExitPrice: number | null;
  partialExitLotPct: number | null;
  lotSize: number;
  pipValue: number;
}

export interface TradeMetrics {
  totalPips: number;
  blendedPnl: number;
  blendedRr: number;
}

/**
 * Computes pips / P&L / R:R for a closed trade. Returns zeros for a live trade
 * (no main exit yet). Partial exits are blended by lot weighting.
 */
export function computeTradeMetrics(input: TradeMetricsInput): TradeMetrics {
  if (input.mainExitPrice == null) {
    return { totalPips: 0, blendedPnl: 0, blendedRr: 0 };
  }

  const mult = pipMultiplierForSymbol(input.symbol);
  const sign = input.direction === 'Buy' ? 1 : -1;
  const legPips = (exit: number) => sign * (exit - input.entryPrice) * mult;

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

  const blendedPnl = totalPips * input.pipValue * input.lotSize;

  const riskPips = Math.abs(input.entryPrice - input.slPrice) * mult;
  const riskMoney = riskPips * input.pipValue * input.lotSize;
  const blendedRr = riskMoney > 0 ? blendedPnl / riskMoney : 0;

  return {
    totalPips: round2(totalPips),
    blendedPnl: round2(blendedPnl),
    blendedRr: round2(blendedRr),
  };
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

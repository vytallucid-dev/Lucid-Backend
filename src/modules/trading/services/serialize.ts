import type { Prisma, CashFlow, PlannedTrade, Trade, TradingModel, TradingPair } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// Serializers: Prisma rows → the exact snake_case shapes the frontend already
// consumes (its demo-data interfaces). Keeping the contract identical means the
// React pages need no field renaming — only their data source changes.
// ─────────────────────────────────────────────────────────────────────────────

type Decimal = Prisma.Decimal;

function num(d: Decimal | null | undefined): number | null {
  return d == null ? null : d.toNumber();
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// A TradingAccount with its cash flows joined.
export type AccountWithFlows = Prisma.TradingAccountGetPayload<{ include: { cashFlows: true } }>;

export interface AccountDto {
  id: string;
  account_type: string;
  account_name: string;
  account_size: number;
  current_balance: number; // live equity: size + trading_pnl + net_deposits
  trading_pnl: number; // realized P&L from closed trades only
  net_deposits: number; // deposits − withdrawals − payouts
  currency: string;
  status: string;
  starting_date: string;
  broker?: string;
  profit_goal_pct: number | null;
  prop_firm?: string;
  stage?: string;
  max_drawdown_pct?: number;
  profit_target_pct?: number;
  cash_flows: Array<{ date: string; type: string; amount: number; note?: string }>;
  payouts: Array<{ date: string; amount: number; running_total: number }>;
}

/**
 * Serializes an account under the full-equity model:
 *   current_balance = account_size + realized trading P&L + net external flows
 * where net external flows = deposits − withdrawals − payouts. `trading_pnl` is
 * exposed separately so the UI can show trading performance undistorted by
 * deposits. `realizedPnl` is the sum of closed-trade P&L for this account.
 */
export function toAccountDto(a: AccountWithFlows, realizedPnl = 0): AccountDto {
  const flows = [...a.cashFlows].sort((x, y) => x.date.getTime() - y.date.getTime());

  const deposits = flows.filter((f) => f.type !== 'payout');
  const payoutRows = flows.filter((f) => f.type === 'payout');

  let running = 0;
  const payouts = payoutRows.map((p) => {
    const amount = num(p.amount) ?? 0;
    running = round2(running + amount);
    return { date: ymd(p.date), amount, running_total: running };
  });

  let netExternal = 0;
  for (const f of flows) {
    const amt = num(f.amount) ?? 0;
    if (f.type === 'deposit') netExternal += amt;
    else netExternal -= amt; // withdrawal or payout removes capital from the account
  }

  const accountSize = num(a.accountSize) ?? 0;
  const tradingPnl = round2(realizedPnl);
  const netDeposits = round2(netExternal);
  const currentBalance = round2(accountSize + tradingPnl + netDeposits);

  return {
    id: a.id,
    account_type: a.accountType,
    account_name: a.accountName,
    account_size: accountSize,
    current_balance: currentBalance,
    trading_pnl: tradingPnl,
    net_deposits: netDeposits,
    currency: a.currency,
    status: a.status,
    starting_date: ymd(a.startingDate),
    broker: a.broker ?? undefined,
    profit_goal_pct: num(a.profitGoalPct),
    prop_firm: a.propFirm ?? undefined,
    stage: a.stage ?? undefined,
    max_drawdown_pct: num(a.maxDrawdownPct) ?? undefined,
    profit_target_pct: num(a.profitTargetPct) ?? undefined,
    cash_flows: deposits.map((f) => ({
      date: ymd(f.date),
      type: f.type,
      amount: num(f.amount) ?? 0,
      note: f.note ?? undefined,
    })),
    payouts,
  };
}

export interface TradeDto {
  id: string;
  account_id: string;
  model: string;
  pair: string;
  direction: string;
  entry_price: number;
  sl_price: number;
  first_tp_price: number | null;
  main_tp_price: number;
  partial_exit_price: number | null;
  partial_exit_lot_pct: number | null;
  main_exit_price: number;
  lot_size: number;
  total_pips: number;
  risk_pct: number;
  conviction: string;
  blended_pnl: number;
  blended_rr: number;
  exit_type: string;
  date_opened: string;
  date_closed: string;
  session: string;
  fundamental_score: number | null;
  screenshots: string[];
  psychology: string;
  notes: string;
  pre_trade_memory: null;
  debrief_memory: null;
}

export function toTradeDto(t: Trade): TradeDto {
  return {
    id: t.id,
    account_id: t.accountId,
    model: t.model,
    pair: t.pair,
    direction: t.direction,
    entry_price: num(t.entryPrice) ?? 0,
    sl_price: num(t.slPrice) ?? 0,
    first_tp_price: num(t.firstTpPrice),
    main_tp_price: num(t.mainTpPrice) ?? 0,
    partial_exit_price: num(t.partialExitPrice),
    partial_exit_lot_pct: num(t.partialExitLotPct),
    main_exit_price: num(t.mainExitPrice) ?? 0,
    lot_size: num(t.lotSize) ?? 0,
    total_pips: num(t.totalPips) ?? 0,
    risk_pct: num(t.riskPct) ?? 0,
    conviction: t.conviction,
    blended_pnl: num(t.blendedPnl) ?? 0,
    blended_rr: num(t.blendedRr) ?? 0,
    exit_type: t.exitType,
    date_opened: t.dateOpened.toISOString(),
    date_closed: t.dateClosed ? t.dateClosed.toISOString() : '',
    session: t.session,
    fundamental_score: t.fundamentalScore,
    screenshots: t.screenshots,
    psychology: t.psychology ?? '',
    notes: t.notes ?? '',
    pre_trade_memory: null,
    debrief_memory: null,
  };
}

export interface PlannedTradeDto {
  id: string;
  pair: string;
  model: string;
  direction: string;
  planned_entry: number;
  planned_sl: number;
  planned_first_tp: number | null;
  planned_main_tp: number;
  planned_risk_pct: number;
  conviction: string;
  status: string;
  date_added: string;
  notes: string;
  screenshots: string[];
  current_market_price: number;
}

export function toPlannedDto(p: PlannedTrade): PlannedTradeDto {
  return {
    id: p.id,
    pair: p.pair,
    model: p.model,
    direction: p.direction,
    planned_entry: num(p.plannedEntry) ?? 0,
    planned_sl: num(p.plannedSl) ?? 0,
    planned_first_tp: num(p.plannedFirstTp),
    planned_main_tp: num(p.plannedMainTp) ?? 0,
    planned_risk_pct: num(p.plannedRiskPct) ?? 0,
    conviction: p.conviction,
    status: p.status,
    date_added: p.dateAdded.toISOString(),
    notes: p.notes ?? '',
    screenshots: p.screenshots,
    current_market_price: num(p.currentMarketPrice) ?? 0,
  };
}

export interface ModelDto {
  id: string;
  name: string;
  description: string;
  rules: string;
  status: string;
}

export function toModelDto(m: TradingModel): ModelDto {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    rules: m.rules,
    status: m.status,
  };
}

export interface PairDto {
  id: string;
  symbol: string;
  display_name: string;
  flag_a: string;
  flag_b: string;
  pip_value: number;
  status: string;
}

export function toPairDto(p: TradingPair): PairDto {
  return {
    id: p.id,
    symbol: p.symbol,
    display_name: p.displayName,
    flag_a: p.flagA,
    flag_b: p.flagB,
    pip_value: num(p.pipValue) ?? 0,
    status: p.status,
  };
}

// Re-export the joined cash-flow row type for callers that need it.
export type { CashFlow };

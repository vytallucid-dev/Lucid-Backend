import type { Prisma, CashFlow, Execution, PlannedTrade, Trade, TradingModel, TradingPair } from '@prisma/client';

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

export interface ExecutionDto {
  id: string;
  trade_id: string;
  account_id: string;
  is_primary: boolean;
  risk_pct: number;
  lot_size: number;
  entry_price: number;
  partial_exit_price: number | null;
  partial_exit_lot_pct: number | null;
  main_exit_price: number;
  total_pips: number;
  blended_pnl: number;
  blended_rr: number;
  exit_type: string;
  date_closed: string;
}

export function toExecutionDto(e: Execution): ExecutionDto {
  return {
    id: e.id,
    trade_id: e.tradeId,
    account_id: e.accountId,
    is_primary: e.isPrimary,
    risk_pct: num(e.riskPct) ?? 0,
    lot_size: num(e.lotSize) ?? 0,
    entry_price: num(e.entryPrice) ?? 0,
    partial_exit_price: num(e.partialExitPrice),
    partial_exit_lot_pct: num(e.partialExitLotPct),
    main_exit_price: num(e.mainExitPrice) ?? 0,
    total_pips: num(e.totalPips) ?? 0,
    blended_pnl: num(e.blendedPnl) ?? 0,
    blended_rr: num(e.blendedRr) ?? 0,
    exit_type: e.exitType,
    date_closed: e.dateClosed ? e.dateClosed.toISOString() : '',
  };
}

// TradeDto is the idea: setup, rationale, and its planned prices, plus every
// execution (fill) it was taken with. Fields that used to live flat on Trade —
// account_id, risk_pct, lot_size, entry_price (as the actual fill), the exit
// fields, total_pips, blended_pnl, blended_rr — now live per-execution inside
// `executions`, since they differ per account. entry_price/sl_price/
// first_tp_price/main_tp_price are renamed planned_entry/planned_sl/
// planned_first_tp/planned_main_tp — same values, now explicitly "the plan".
export interface TradeDto {
  id: string;
  model: string;
  pair: string;
  direction: string;
  planned_entry: number;
  planned_sl: number;
  planned_first_tp: number | null;
  planned_main_tp: number;
  conviction: string;
  date_opened: string;
  session: string;
  fundamental_score: number | null;
  screenshots: string[];
  psychology: string;
  notes: string;
  pre_trade_memory: null;
  debrief_memory: null;
  executions: ExecutionDto[];
}

export type TradeWithExecutions = Trade & { executions: Execution[] };

export function toTradeDto(t: TradeWithExecutions): TradeDto {
  return {
    id: t.id,
    model: t.model,
    pair: t.pair,
    direction: t.direction,
    planned_entry: num(t.plannedEntry) ?? 0,
    planned_sl: num(t.plannedSl) ?? 0,
    planned_first_tp: num(t.plannedFirstTp),
    planned_main_tp: num(t.plannedMainTp) ?? 0,
    conviction: t.conviction,
    date_opened: t.dateOpened.toISOString(),
    session: t.session,
    fundamental_score: t.fundamentalScore,
    screenshots: t.screenshots,
    psychology: t.psychology ?? '',
    notes: t.notes ?? '',
    pre_trade_memory: null,
    debrief_memory: null,
    // Primary first, then the rest in creation order — the primary execution
    // is the idea's outcome for edge statistics (see lib/stats.ts frontend).
    executions: [...t.executions]
      .sort((a, b) => (a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1))
      .map(toExecutionDto),
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

import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { toTradeDto, type TradeDto, type TradeWithExecutions } from './serialize';
import { computeTradeMetrics, sessionFromDate } from './trade-metrics';
import type {
  CreateTradeInput,
  UpdateTradeInput,
  CreateExecutionInput,
  UpdateExecutionInput,
} from '../types/trading.types';

const includeExecutions = { executions: true } as const;

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

function decOrNull(n: number | null | undefined): Prisma.Decimal | null {
  return n == null ? null : new Prisma.Decimal(n);
}

/** Resolves the pip value for a user's pair symbol (defaults to 10 if unknown). */
async function pipValueFor(userId: string, symbol: string): Promise<number> {
  const pair = await prisma.tradingPair.findUnique({
    where: { userId_symbol: { userId, symbol } },
    select: { pipValue: true },
  });
  return pair ? pair.pipValue.toNumber() : 10;
}

async function assertAccountOwned(userId: string, accountId: string): Promise<void> {
  const account = await prisma.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!account) {
    throw new AppError(400, 'Account not found for this user', 'ACCOUNT_NOT_FOUND');
  }
}

/** Loads a trade (idea) with its executions, or throws 404. Scoped to the owning user. */
async function loadOwnedTrade(userId: string, id: string): Promise<TradeWithExecutions> {
  const trade = await prisma.trade.findFirst({ where: { id, userId }, include: includeExecutions });
  if (!trade) throw new AppError(404, 'Trade not found', 'TRADE_NOT_FOUND');
  return trade;
}

async function loadOwnedExecution(userId: string, tradeId: string, executionId: string) {
  const trade = await loadOwnedTrade(userId, tradeId);
  const execution = trade.executions.find((e) => e.id === executionId);
  if (!execution) throw new AppError(404, 'Execution not found', 'EXECUTION_NOT_FOUND');
  return { trade, execution };
}

/**
 * Derives an execution's totalPips/blendedPnl/blendedRr. Risk is measured
 * against the *idea's* stop (trade.plannedSl) — the invalidation level is
 * shared across accounts — while pips/P&L are measured from this execution's
 * own actual entry and exit. Because blendedRr algebraically reduces to
 * totalPips / riskPips (lot size and pip value cancel), it is comparable
 * across accounts of different sizes, which is what makes R the right unit
 * for edge statistics.
 */
async function computeExecutionMetrics(
  userId: string,
  pair: string,
  plannedSl: number,
  execEntryPrice: number,
  direction: 'Buy' | 'Sell',
  isClosed: boolean,
  mainExitPrice: number | null | undefined,
  partialExitPrice: number | null | undefined,
  partialExitLotPct: number | null | undefined,
  lotSize: number,
) {
  const pipValue = await pipValueFor(userId, pair);
  return computeTradeMetrics({
    direction,
    symbol: pair,
    entryPrice: execEntryPrice,
    slPrice: plannedSl,
    mainExitPrice: isClosed ? (mainExitPrice ?? null) : null,
    partialExitPrice: partialExitPrice ?? null,
    partialExitLotPct: partialExitLotPct ?? null,
    lotSize,
    pipValue,
  });
}

// ─── Trades (ideas) ──────────────────────────────────────────────────────────

/**
 * Lists a user's ideas. When accountId is given, only ideas that have at
 * least one execution in that account are returned, and each returned idea's
 * `executions` array is filtered down to that account's execution(s) only —
 * "show me account X" means "X's fills", not every account the idea also ran
 * in.
 */
export async function listTrades(userId: string, accountId?: string): Promise<TradeDto[]> {
  const trades = await prisma.trade.findMany({
    where: {
      userId,
      ...(accountId ? { executions: { some: { accountId } } } : {}),
    },
    include: includeExecutions,
    orderBy: { dateOpened: 'desc' },
  });
  if (!accountId) return trades.map(toTradeDto);
  return trades.map((t) =>
    toTradeDto({ ...t, executions: t.executions.filter((e) => e.accountId === accountId) }),
  );
}

export async function getTrade(userId: string, id: string): Promise<TradeDto> {
  return toTradeDto(await loadOwnedTrade(userId, id));
}

export async function createTrade(userId: string, input: CreateTradeInput): Promise<TradeDto> {
  for (const ex of input.executions) {
    await assertAccountOwned(userId, ex.account_id);
  }

  const dateOpened = input.date_opened ? new Date(input.date_opened) : new Date();
  const session = sessionFromDate(dateOpened);

  const markedPrimaryIdx = input.executions.findIndex((e) => e.is_primary);
  const primaryIdx = markedPrimaryIdx >= 0 ? markedPrimaryIdx : 0;

  const executionRows = await Promise.all(
    input.executions.map(async (ex, idx) => {
      const isClosed = ex.is_closed && ex.main_exit_price != null;
      const metrics = await computeExecutionMetrics(
        userId,
        input.pair,
        input.planned_sl,
        ex.entry_price,
        input.direction,
        isClosed,
        ex.main_exit_price,
        ex.partial_exit_price,
        ex.partial_exit_lot_pct,
        ex.lot_size,
      );
      const resultPnl = isClosed && ex.net_pnl != null ? ex.net_pnl : metrics.blendedPnl;
      const dateClosed = isClosed ? (ex.date_closed ? new Date(ex.date_closed) : new Date()) : null;
      return {
        accountId: ex.account_id,
        isPrimary: idx === primaryIdx,
        riskPct: dec(ex.risk_pct),
        lotSize: dec(ex.lot_size),
        entryPrice: dec(ex.entry_price),
        partialExitPrice: isClosed ? decOrNull(ex.partial_exit_price) : null,
        partialExitLotPct: isClosed ? decOrNull(ex.partial_exit_lot_pct) : null,
        mainExitPrice: isClosed ? decOrNull(ex.main_exit_price) : null,
        exitType: ex.exit_type,
        dateClosed,
        totalPips: dec(metrics.totalPips),
        blendedPnl: dec(resultPnl),
        blendedRr: dec(metrics.blendedRr),
      };
    }),
  );

  const created = await prisma.$transaction(async (tx) => {
    const trade = await tx.trade.create({
      data: {
        userId,
        model: input.model,
        pair: input.pair,
        direction: input.direction,
        plannedEntry: dec(input.planned_entry),
        plannedSl: dec(input.planned_sl),
        plannedFirstTp: decOrNull(input.planned_first_tp),
        plannedMainTp: dec(input.planned_main_tp),
        conviction: input.conviction,
        dateOpened,
        session,
        fundamentalScore: input.fundamental_score ?? null,
        screenshots: input.screenshots ?? [],
        psychology: input.psychology ?? null,
        notes: input.notes ?? null,
      },
    });
    await tx.execution.createMany({
      data: executionRows.map((row) => ({ ...row, tradeId: trade.id })),
    });
    return tx.trade.findUniqueOrThrow({ where: { id: trade.id }, include: includeExecutions });
  });

  return toTradeDto(created);
}

export async function updateTrade(
  userId: string,
  id: string,
  input: UpdateTradeInput,
): Promise<TradeDto> {
  const existing = await loadOwnedTrade(userId, id);

  const pair = input.pair ?? existing.pair;
  const direction = (input.direction ?? existing.direction) as 'Buy' | 'Sell';
  const plannedSl = input.planned_sl ?? existing.plannedSl.toNumber();
  const dateOpened = input.date_opened ? new Date(input.date_opened) : existing.dateOpened;

  // Pair and planned stop feed every execution's pip-multiplier / risk-distance
  // math. If either changes, pips and R:R for every execution are recomputed
  // from that execution's own stored prices. P&L stays sticky (matches the
  // pre-split convention: a manual/derived P&L is never silently recomputed
  // by an unrelated edit — only a fresh net_pnl on that execution changes it).
  const metricsAffectingFieldsChanged =
    (input.pair !== undefined && input.pair !== existing.pair) ||
    (input.planned_sl !== undefined && input.planned_sl !== existing.plannedSl.toNumber());

  const data: Prisma.TradeUpdateInput = {
    model: input.model ?? existing.model,
    pair,
    direction,
    plannedSl: dec(plannedSl),
    dateOpened,
    session: sessionFromDate(dateOpened),
    conviction: input.conviction ?? existing.conviction,
  };
  if (input.planned_entry !== undefined) data.plannedEntry = dec(input.planned_entry);
  if (input.planned_first_tp !== undefined) data.plannedFirstTp = decOrNull(input.planned_first_tp);
  if (input.planned_main_tp !== undefined) data.plannedMainTp = dec(input.planned_main_tp);
  if (input.fundamental_score !== undefined) data.fundamentalScore = input.fundamental_score;
  if (input.psychology !== undefined) data.psychology = input.psychology;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.screenshots !== undefined) data.screenshots = input.screenshots;

  const updated = await prisma.$transaction(async (tx) => {
    const trade = await tx.trade.update({ where: { id }, data });

    if (metricsAffectingFieldsChanged) {
      for (const ex of existing.executions) {
        const isClosed = ex.dateClosed != null && ex.mainExitPrice != null;
        const metrics = await computeExecutionMetrics(
          userId,
          pair,
          plannedSl,
          ex.entryPrice.toNumber(),
          direction,
          isClosed,
          ex.mainExitPrice ? ex.mainExitPrice.toNumber() : null,
          ex.partialExitPrice ? ex.partialExitPrice.toNumber() : null,
          ex.partialExitLotPct ? ex.partialExitLotPct.toNumber() : null,
          ex.lotSize.toNumber(),
        );
        await tx.execution.update({
          where: { id: ex.id },
          data: { totalPips: dec(metrics.totalPips), blendedRr: dec(metrics.blendedRr) },
        });
      }
    }

    return tx.trade.findUniqueOrThrow({ where: { id: trade.id }, include: includeExecutions });
  });

  return toTradeDto(updated);
}

export async function deleteTrade(userId: string, id: string): Promise<void> {
  await loadOwnedTrade(userId, id);
  await prisma.trade.delete({ where: { id } }); // executions cascade via FK
}

// ─── Executions (fills, per account) ────────────────────────────────────────

export async function addExecution(
  userId: string,
  tradeId: string,
  input: CreateExecutionInput,
): Promise<TradeDto> {
  const trade = await loadOwnedTrade(userId, tradeId);
  await assertAccountOwned(userId, input.account_id);

  const isClosed = input.is_closed && input.main_exit_price != null;
  const metrics = await computeExecutionMetrics(
    userId,
    trade.pair,
    trade.plannedSl.toNumber(),
    input.entry_price,
    trade.direction as 'Buy' | 'Sell',
    isClosed,
    input.main_exit_price,
    input.partial_exit_price,
    input.partial_exit_lot_pct,
    input.lot_size,
  );
  const resultPnl = isClosed && input.net_pnl != null ? input.net_pnl : metrics.blendedPnl;
  const dateClosed = isClosed ? (input.date_closed ? new Date(input.date_closed) : new Date()) : null;
  const wantsPrimary = input.is_primary === true;

  await prisma.$transaction(async (tx) => {
    if (wantsPrimary) {
      await tx.execution.updateMany({ where: { tradeId, isPrimary: true }, data: { isPrimary: false } });
    }
    await tx.execution.create({
      data: {
        tradeId,
        accountId: input.account_id,
        isPrimary: wantsPrimary,
        riskPct: dec(input.risk_pct),
        lotSize: dec(input.lot_size),
        entryPrice: dec(input.entry_price),
        partialExitPrice: isClosed ? decOrNull(input.partial_exit_price) : null,
        partialExitLotPct: isClosed ? decOrNull(input.partial_exit_lot_pct) : null,
        mainExitPrice: isClosed ? decOrNull(input.main_exit_price) : null,
        exitType: input.exit_type,
        dateClosed,
        totalPips: dec(metrics.totalPips),
        blendedPnl: dec(resultPnl),
        blendedRr: dec(metrics.blendedRr),
      },
    });
  });

  return getTrade(userId, tradeId);
}

export async function updateExecution(
  userId: string,
  tradeId: string,
  executionId: string,
  input: UpdateExecutionInput,
): Promise<TradeDto> {
  const { trade, execution } = await loadOwnedExecution(userId, tradeId, executionId);
  if (input.account_id !== undefined) await assertAccountOwned(userId, input.account_id);

  if (input.is_primary === false && execution.isPrimary) {
    throw new AppError(
      400,
      'Cannot unset the primary execution directly — set another execution as primary instead',
      'PRIMARY_REQUIRED',
    );
  }

  const entryPrice = input.entry_price ?? execution.entryPrice.toNumber();
  const lotSize = input.lot_size ?? execution.lotSize.toNumber();
  const wasClosed = execution.dateClosed != null;
  const isClosed = input.is_closed ?? wasClosed;

  const mainExitPrice =
    input.main_exit_price !== undefined
      ? input.main_exit_price
      : execution.mainExitPrice
        ? execution.mainExitPrice.toNumber()
        : null;
  const partialExitPrice =
    input.partial_exit_price !== undefined
      ? input.partial_exit_price
      : execution.partialExitPrice
        ? execution.partialExitPrice.toNumber()
        : null;
  const partialExitLotPct =
    input.partial_exit_lot_pct !== undefined
      ? input.partial_exit_lot_pct
      : execution.partialExitLotPct
        ? execution.partialExitLotPct.toNumber()
        : null;

  const effectiveClosed = isClosed && mainExitPrice != null;

  let dateClosed: Date | null = execution.dateClosed;
  if (input.is_closed === false) dateClosed = null;
  else if (effectiveClosed) {
    dateClosed = input.date_closed ? new Date(input.date_closed) : (execution.dateClosed ?? new Date());
  }

  const metrics = await computeExecutionMetrics(
    userId,
    trade.pair,
    trade.plannedSl.toNumber(),
    entryPrice,
    trade.direction as 'Buy' | 'Sell',
    effectiveClosed,
    mainExitPrice,
    partialExitPrice,
    partialExitLotPct,
    lotSize,
  );
  // Realized P&L is the user-entered net_pnl (stored verbatim, never
  // recomputed from prices). Not yet closed → 0. Closed and this update
  // doesn't touch net_pnl → preserve the value already stored.
  const resultPnl = !effectiveClosed
    ? 0
    : input.net_pnl !== undefined
      ? (input.net_pnl ?? metrics.blendedPnl)
      : execution.blendedPnl.toNumber();

  const data: Prisma.ExecutionUpdateInput = {
    entryPrice: dec(entryPrice),
    lotSize: dec(lotSize),
    riskPct: input.risk_pct !== undefined ? dec(input.risk_pct) : execution.riskPct,
    exitType: input.exit_type ?? execution.exitType,
    dateClosed,
    mainExitPrice: effectiveClosed ? decOrNull(mainExitPrice) : null,
    partialExitPrice: effectiveClosed ? decOrNull(partialExitPrice) : null,
    partialExitLotPct: effectiveClosed ? decOrNull(partialExitLotPct) : null,
    totalPips: dec(metrics.totalPips),
    blendedPnl: dec(resultPnl),
    blendedRr: dec(metrics.blendedRr),
  };
  if (input.account_id !== undefined) data.account = { connect: { id: input.account_id } };

  await prisma.$transaction(async (tx) => {
    if (input.is_primary === true && !execution.isPrimary) {
      await tx.execution.updateMany({ where: { tradeId, isPrimary: true }, data: { isPrimary: false } });
      data.isPrimary = true;
    }
    await tx.execution.update({ where: { id: executionId }, data });
  });

  return getTrade(userId, tradeId);
}

/**
 * Removes an execution. Rejects removing the last execution on a trade (a
 * trade with no executions is invalid). If the removed execution was primary,
 * promotes the remaining execution with the earliest createdAt — i.e. the
 * next-oldest surviving fill, mirroring "if none marked, the first is
 * primary" at creation time.
 */
export async function removeExecution(
  userId: string,
  tradeId: string,
  executionId: string,
): Promise<TradeDto> {
  const { trade, execution } = await loadOwnedExecution(userId, tradeId, executionId);
  if (trade.executions.length <= 1) {
    throw new AppError(400, 'Cannot remove the last execution on a trade', 'LAST_EXECUTION');
  }

  await prisma.$transaction(async (tx) => {
    await tx.execution.delete({ where: { id: executionId } });
    if (execution.isPrimary) {
      const remaining = trade.executions
        .filter((e) => e.id !== executionId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const promote = remaining[0];
      if (promote) {
        await tx.execution.update({ where: { id: promote.id }, data: { isPrimary: true } });
      }
    }
  });

  return getTrade(userId, tradeId);
}

export async function setPrimaryExecution(
  userId: string,
  tradeId: string,
  executionId: string,
): Promise<TradeDto> {
  const { execution } = await loadOwnedExecution(userId, tradeId, executionId);
  if (!execution.isPrimary) {
    await prisma.$transaction(async (tx) => {
      await tx.execution.updateMany({ where: { tradeId, isPrimary: true }, data: { isPrimary: false } });
      await tx.execution.update({ where: { id: executionId }, data: { isPrimary: true } });
    });
  }
  return getTrade(userId, tradeId);
}

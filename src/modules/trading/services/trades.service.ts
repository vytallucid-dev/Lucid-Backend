import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { toTradeDto, type TradeDto } from './serialize';
import { computeTradeMetrics, sessionFromDate } from './trade-metrics';
import type { CreateTradeInput, UpdateTradeInput } from '../types/trading.types';

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

export async function listTrades(userId: string, accountId?: string): Promise<TradeDto[]> {
  const trades = await prisma.trade.findMany({
    where: { userId, ...(accountId ? { accountId } : {}) },
    orderBy: { dateOpened: 'desc' },
  });
  return trades.map(toTradeDto);
}

export async function getTrade(userId: string, id: string): Promise<TradeDto> {
  const trade = await prisma.trade.findFirst({ where: { id, userId } });
  if (!trade) throw new AppError(404, 'Trade not found', 'TRADE_NOT_FOUND');
  return toTradeDto(trade);
}

export async function createTrade(userId: string, input: CreateTradeInput): Promise<TradeDto> {
  await assertAccountOwned(userId, input.account_id);

  const dateOpened = input.date_opened ? new Date(input.date_opened) : new Date();
  const isClosed = input.is_closed && input.main_exit_price != null;
  const dateClosed = isClosed ? (input.date_closed ? new Date(input.date_closed) : new Date()) : null;

  const pipValue = await pipValueFor(userId, input.pair);
  // Pips and R:R stay derived (display metrics). The trade's realized P&L is the
  // user-entered net_pnl when supplied — stored verbatim, no recompute — falling
  // back to the computed blendedPnl only when the client sends no manual value.
  const metrics = computeTradeMetrics({
    direction: input.direction,
    symbol: input.pair,
    entryPrice: input.entry_price,
    slPrice: input.sl_price,
    mainExitPrice: isClosed ? input.main_exit_price! : null,
    partialExitPrice: input.partial_exit_price ?? null,
    partialExitLotPct: input.partial_exit_lot_pct ?? null,
    lotSize: input.lot_size,
    pipValue,
  });
  const resultPnl = isClosed && input.net_pnl != null ? input.net_pnl : metrics.blendedPnl;

  const created = await prisma.trade.create({
    data: {
      userId,
      accountId: input.account_id,
      model: input.model,
      pair: input.pair,
      direction: input.direction,
      entryPrice: dec(input.entry_price),
      slPrice: dec(input.sl_price),
      firstTpPrice: decOrNull(input.first_tp_price),
      mainTpPrice: dec(input.main_tp_price),
      partialExitPrice: isClosed ? decOrNull(input.partial_exit_price) : null,
      partialExitLotPct: isClosed ? decOrNull(input.partial_exit_lot_pct) : null,
      mainExitPrice: isClosed ? decOrNull(input.main_exit_price) : null,
      lotSize: dec(input.lot_size),
      totalPips: dec(metrics.totalPips),
      riskPct: dec(input.risk_pct),
      conviction: input.conviction,
      blendedPnl: dec(resultPnl),
      blendedRr: dec(metrics.blendedRr),
      exitType: input.exit_type,
      dateOpened,
      dateClosed,
      session: sessionFromDate(dateOpened),
      fundamentalScore: input.fundamental_score ?? null,
      screenshots: input.screenshots ?? [],
      psychology: input.psychology ?? null,
      notes: input.notes ?? null,
    },
  });
  return toTradeDto(created);
}

export async function updateTrade(
  userId: string,
  id: string,
  input: UpdateTradeInput,
): Promise<TradeDto> {
  const existing = await prisma.trade.findFirst({ where: { id, userId } });
  if (!existing) throw new AppError(404, 'Trade not found', 'TRADE_NOT_FOUND');

  if (input.account_id !== undefined) await assertAccountOwned(userId, input.account_id);

  // Merge incoming fields over the current row, then recompute derived metrics
  // (pips / pnl / rr / session) from the effective values.
  const direction = (input.direction ?? existing.direction) as 'Buy' | 'Sell';
  const pair = input.pair ?? existing.pair;
  const entryPrice = input.entry_price ?? existing.entryPrice.toNumber();
  const slPrice = input.sl_price ?? existing.slPrice.toNumber();
  const lotSize = input.lot_size ?? existing.lotSize.toNumber();

  const wasClosed = existing.dateClosed != null;
  const isClosed = input.is_closed ?? wasClosed;

  const mainExitPrice =
    input.main_exit_price !== undefined
      ? input.main_exit_price
      : existing.mainExitPrice
        ? existing.mainExitPrice.toNumber()
        : null;
  const partialExitPrice =
    input.partial_exit_price !== undefined
      ? input.partial_exit_price
      : existing.partialExitPrice
        ? existing.partialExitPrice.toNumber()
        : null;
  const partialExitLotPct =
    input.partial_exit_lot_pct !== undefined
      ? input.partial_exit_lot_pct
      : existing.partialExitLotPct
        ? existing.partialExitLotPct.toNumber()
        : null;

  const effectiveClosed = isClosed && mainExitPrice != null;

  const dateOpened = input.date_opened ? new Date(input.date_opened) : existing.dateOpened;
  let dateClosed: Date | null = existing.dateClosed;
  if (input.is_closed === false) dateClosed = null;
  else if (effectiveClosed) {
    dateClosed = input.date_closed
      ? new Date(input.date_closed)
      : (existing.dateClosed ?? new Date());
  }

  const pipValue = await pipValueFor(userId, pair);
  const metrics = computeTradeMetrics({
    direction,
    symbol: pair,
    entryPrice,
    slPrice,
    mainExitPrice: effectiveClosed ? mainExitPrice : null,
    partialExitPrice,
    partialExitLotPct,
    lotSize,
    pipValue,
  });
  // Realized P&L is the user-entered net_pnl (stored verbatim, never recomputed
  // from prices). An open trade has no result, so P&L is 0. When closed and this
  // update doesn't touch net_pnl, preserve the value already stored.
  const resultPnl = !effectiveClosed
    ? 0
    : input.net_pnl !== undefined
      ? (input.net_pnl ?? metrics.blendedPnl)
      : existing.blendedPnl.toNumber();

  const data: Prisma.TradeUpdateInput = {
    model: input.model ?? existing.model,
    pair,
    direction,
    entryPrice: dec(entryPrice),
    slPrice: dec(slPrice),
    mainTpPrice: input.main_tp_price !== undefined ? dec(input.main_tp_price) : existing.mainTpPrice,
    lotSize: dec(lotSize),
    riskPct: input.risk_pct !== undefined ? dec(input.risk_pct) : existing.riskPct,
    conviction: input.conviction ?? existing.conviction,
    exitType: input.exit_type ?? existing.exitType,
    dateOpened,
    dateClosed,
    session: sessionFromDate(dateOpened),
    mainExitPrice: effectiveClosed ? decOrNull(mainExitPrice) : null,
    partialExitPrice: effectiveClosed ? decOrNull(partialExitPrice) : null,
    partialExitLotPct: effectiveClosed ? decOrNull(partialExitLotPct) : null,
    totalPips: dec(metrics.totalPips),
    blendedPnl: dec(resultPnl),
    blendedRr: dec(metrics.blendedRr),
  };
  if (input.first_tp_price !== undefined) data.firstTpPrice = decOrNull(input.first_tp_price);
  if (input.fundamental_score !== undefined) data.fundamentalScore = input.fundamental_score;
  if (input.psychology !== undefined) data.psychology = input.psychology;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.screenshots !== undefined) data.screenshots = input.screenshots;
  if (input.account_id !== undefined) data.account = { connect: { id: input.account_id } };

  const updated = await prisma.trade.update({ where: { id }, data });
  return toTradeDto(updated);
}

export async function deleteTrade(userId: string, id: string): Promise<void> {
  const existing = await prisma.trade.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new AppError(404, 'Trade not found', 'TRADE_NOT_FOUND');
  await prisma.trade.delete({ where: { id } });
}

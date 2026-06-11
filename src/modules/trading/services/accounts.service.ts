import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import {
  toAccountDto,
  type AccountDto,
  type AccountWithFlows,
} from './serialize';
import type {
  CreateAccountInput,
  UpdateAccountInput,
  CashFlowInput,
} from '../types/trading.types';

const includeFlows = { cashFlows: true } as const;

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

function dateAt(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** Loads an account the caller owns, or throws 404. */
async function loadOwnedAccount(userId: string, id: string): Promise<AccountWithFlows> {
  const account = await prisma.tradingAccount.findFirst({
    where: { id, userId },
    include: includeFlows,
  });
  if (!account) {
    throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND');
  }
  return account;
}

/** Sum of realized P&L from closed trades, grouped by account, for one user. */
async function realizedPnlByAccount(userId: string): Promise<Map<string, number>> {
  const rows = await prisma.trade.groupBy({
    by: ['accountId'],
    where: { userId, dateClosed: { not: null } },
    _sum: { blendedPnl: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.accountId, r._sum.blendedPnl ? r._sum.blendedPnl.toNumber() : 0);
  }
  return map;
}

/** Sum of realized P&L from closed trades for a single account. */
async function realizedPnlForAccount(accountId: string): Promise<number> {
  const agg = await prisma.trade.aggregate({
    where: { accountId, dateClosed: { not: null } },
    _sum: { blendedPnl: true },
  });
  return agg._sum.blendedPnl ? agg._sum.blendedPnl.toNumber() : 0;
}

export async function listAccounts(userId: string): Promise<AccountDto[]> {
  const [accounts, realized] = await Promise.all([
    prisma.tradingAccount.findMany({
      where: { userId },
      include: includeFlows,
      orderBy: { createdAt: 'desc' },
    }),
    realizedPnlByAccount(userId),
  ]);
  return accounts.map((a) => toAccountDto(a, realized.get(a.id) ?? 0));
}

export async function getAccount(userId: string, id: string): Promise<AccountDto> {
  const account = await loadOwnedAccount(userId, id);
  return toAccountDto(account, await realizedPnlForAccount(id));
}

export async function createAccount(userId: string, input: CreateAccountInput): Promise<AccountDto> {
  const size = input.account_size;
  const created = await prisma.tradingAccount.create({
    data: {
      userId,
      accountType: input.account_type,
      accountName: input.account_name,
      accountSize: dec(size),
      currentBalance: dec(input.current_balance ?? size),
      currency: input.currency,
      status: input.status,
      startingDate: dateAt(input.starting_date),
      broker: input.broker ?? null,
      profitGoalPct: input.profit_goal_pct != null ? dec(input.profit_goal_pct) : null,
      propFirm: input.prop_firm ?? null,
      stage: input.stage ?? null,
      maxDrawdownPct: input.max_drawdown_pct != null ? dec(input.max_drawdown_pct) : null,
      profitTargetPct: input.profit_target_pct != null ? dec(input.profit_target_pct) : null,
    },
    include: includeFlows,
  });
  return toAccountDto(created);
}

export async function updateAccount(
  userId: string,
  id: string,
  input: UpdateAccountInput,
): Promise<AccountDto> {
  await loadOwnedAccount(userId, id);

  const data: Prisma.TradingAccountUpdateInput = {};
  if (input.account_type !== undefined) data.accountType = input.account_type;
  if (input.account_name !== undefined) data.accountName = input.account_name;
  if (input.account_size !== undefined) data.accountSize = dec(input.account_size);
  if (input.current_balance !== undefined) data.currentBalance = dec(input.current_balance);
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.status !== undefined) data.status = input.status;
  if (input.starting_date !== undefined) data.startingDate = dateAt(input.starting_date);
  if (input.broker !== undefined) data.broker = input.broker;
  if (input.profit_goal_pct !== undefined)
    data.profitGoalPct = input.profit_goal_pct != null ? dec(input.profit_goal_pct) : null;
  if (input.prop_firm !== undefined) data.propFirm = input.prop_firm;
  if (input.stage !== undefined) data.stage = input.stage;
  if (input.max_drawdown_pct !== undefined)
    data.maxDrawdownPct = input.max_drawdown_pct != null ? dec(input.max_drawdown_pct) : null;
  if (input.profit_target_pct !== undefined)
    data.profitTargetPct = input.profit_target_pct != null ? dec(input.profit_target_pct) : null;

  const updated = await prisma.tradingAccount.update({
    where: { id },
    data,
    include: includeFlows,
  });
  return toAccountDto(updated, await realizedPnlForAccount(id));
}

export async function deleteAccount(userId: string, id: string): Promise<void> {
  await loadOwnedAccount(userId, id);
  // Trades + cash flows cascade via FK ON DELETE CASCADE.
  await prisma.tradingAccount.delete({ where: { id } });
}

export async function addCashFlow(
  userId: string,
  accountId: string,
  input: CashFlowInput,
): Promise<AccountDto> {
  await loadOwnedAccount(userId, accountId);
  await prisma.cashFlow.create({
    data: {
      userId,
      accountId,
      type: input.type,
      amount: dec(input.amount),
      date: dateAt(input.date),
      note: input.note ?? null,
    },
  });
  // Return the full, freshly-joined account so the client gets updated
  // cash_flows / payouts (and recomputed equity) in one round-trip.
  return toAccountDto(await loadOwnedAccount(userId, accountId), await realizedPnlForAccount(accountId));
}

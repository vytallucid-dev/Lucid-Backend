import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { toPairDto, type PairDto } from './serialize';
import { seedDefaultPairsIfNeeded } from './bootstrap.service';
import type { CreatePairInput, UpdatePairInput } from '../types/trading.types';

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

export async function listPairs(userId: string): Promise<PairDto[]> {
  await seedDefaultPairsIfNeeded(userId);
  const rows = await prisma.tradingPair.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toPairDto);
}

export async function createPair(userId: string, input: CreatePairInput): Promise<PairDto> {
  try {
    const created = await prisma.tradingPair.create({
      data: {
        userId,
        symbol: input.symbol,
        displayName: input.display_name,
        flagA: input.flag_a,
        flagB: input.flag_b,
        pipValue: dec(input.pip_value),
        status: input.status,
      },
    });
    return toPairDto(created);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, `A pair "${input.symbol}" already exists`, 'PAIR_EXISTS');
    }
    throw err;
  }
}

export async function updatePair(
  userId: string,
  id: string,
  input: UpdatePairInput,
): Promise<PairDto> {
  const existing = await prisma.tradingPair.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new AppError(404, 'Pair not found', 'PAIR_NOT_FOUND');

  const data: Prisma.TradingPairUpdateInput = {};
  if (input.symbol !== undefined) data.symbol = input.symbol;
  if (input.display_name !== undefined) data.displayName = input.display_name;
  if (input.flag_a !== undefined) data.flagA = input.flag_a;
  if (input.flag_b !== undefined) data.flagB = input.flag_b;
  if (input.pip_value !== undefined) data.pipValue = dec(input.pip_value);
  if (input.status !== undefined) data.status = input.status;

  try {
    const updated = await prisma.tradingPair.update({ where: { id }, data });
    return toPairDto(updated);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, `A pair "${input.symbol}" already exists`, 'PAIR_EXISTS');
    }
    throw err;
  }
}

export async function deletePair(userId: string, id: string): Promise<void> {
  const existing = await prisma.tradingPair.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new AppError(404, 'Pair not found', 'PAIR_NOT_FOUND');
  await prisma.tradingPair.delete({ where: { id } });
}

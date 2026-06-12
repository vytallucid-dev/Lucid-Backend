import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { toPlannedDto, type PlannedTradeDto } from './serialize';
import type { CreatePlannedInput, UpdatePlannedInput } from '../types/trading.types';

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

function decOrNull(n: number | null | undefined): Prisma.Decimal | null {
  return n == null ? null : new Prisma.Decimal(n);
}

export async function listPlanned(userId: string): Promise<PlannedTradeDto[]> {
  const rows = await prisma.plannedTrade.findMany({
    where: { userId },
    orderBy: { dateAdded: 'desc' },
  });
  return rows.map(toPlannedDto);
}

export async function getPlanned(userId: string, id: string): Promise<PlannedTradeDto> {
  const row = await prisma.plannedTrade.findFirst({ where: { id, userId } });
  if (!row) throw new AppError(404, 'Planned trade not found', 'PLANNED_NOT_FOUND');
  return toPlannedDto(row);
}

export async function createPlanned(
  userId: string,
  input: CreatePlannedInput,
): Promise<PlannedTradeDto> {
  const created = await prisma.plannedTrade.create({
    data: {
      userId,
      pair: input.pair,
      model: input.model,
      direction: input.direction,
      plannedEntry: dec(input.planned_entry),
      plannedSl: dec(input.planned_sl),
      plannedFirstTp: decOrNull(input.planned_first_tp),
      plannedMainTp: dec(input.planned_main_tp),
      plannedRiskPct: dec(input.planned_risk_pct),
      conviction: input.conviction,
      status: input.status,
      notes: input.notes ?? null,
      screenshots: input.screenshots ?? [],
      currentMarketPrice: dec(input.current_market_price ?? input.planned_entry),
      // Defaults to now() at the DB level when the user doesn't pick a date.
      ...(input.date_added ? { dateAdded: new Date(input.date_added) } : {}),
    },
  });
  return toPlannedDto(created);
}

export async function updatePlanned(
  userId: string,
  id: string,
  input: UpdatePlannedInput,
): Promise<PlannedTradeDto> {
  const existing = await prisma.plannedTrade.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new AppError(404, 'Planned trade not found', 'PLANNED_NOT_FOUND');

  const data: Prisma.PlannedTradeUpdateInput = {};
  if (input.pair !== undefined) data.pair = input.pair;
  if (input.model !== undefined) data.model = input.model;
  if (input.direction !== undefined) data.direction = input.direction;
  if (input.planned_entry !== undefined) data.plannedEntry = dec(input.planned_entry);
  if (input.planned_sl !== undefined) data.plannedSl = dec(input.planned_sl);
  if (input.planned_first_tp !== undefined) data.plannedFirstTp = decOrNull(input.planned_first_tp);
  if (input.planned_main_tp !== undefined) data.plannedMainTp = dec(input.planned_main_tp);
  if (input.planned_risk_pct !== undefined) data.plannedRiskPct = dec(input.planned_risk_pct);
  if (input.conviction !== undefined) data.conviction = input.conviction;
  if (input.status !== undefined) data.status = input.status;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.screenshots !== undefined) data.screenshots = input.screenshots;
  if (input.current_market_price !== undefined)
    data.currentMarketPrice = dec(input.current_market_price);
  if (input.date_added !== undefined) data.dateAdded = new Date(input.date_added);

  const updated = await prisma.plannedTrade.update({ where: { id }, data });
  return toPlannedDto(updated);
}

export async function deletePlanned(userId: string, id: string): Promise<void> {
  const existing = await prisma.plannedTrade.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new AppError(404, 'Planned trade not found', 'PLANNED_NOT_FOUND');
  await prisma.plannedTrade.delete({ where: { id } });
}

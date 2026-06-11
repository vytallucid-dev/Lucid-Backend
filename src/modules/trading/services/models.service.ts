import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { toModelDto, type ModelDto } from './serialize';
import { seedDefaultModelsIfNeeded } from './bootstrap.service';
import type { CreateModelInput, UpdateModelInput } from '../types/trading.types';

export async function listModels(userId: string): Promise<ModelDto[]> {
  await seedDefaultModelsIfNeeded(userId);
  const rows = await prisma.tradingModel.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toModelDto);
}

export async function createModel(userId: string, input: CreateModelInput): Promise<ModelDto> {
  try {
    const created = await prisma.tradingModel.create({
      data: {
        userId,
        name: input.name,
        description: input.description,
        rules: input.rules,
        status: input.status,
      },
    });
    return toModelDto(created);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, `A model named "${input.name}" already exists`, 'MODEL_EXISTS');
    }
    throw err;
  }
}

export async function updateModel(
  userId: string,
  id: string,
  input: UpdateModelInput,
): Promise<ModelDto> {
  const existing = await prisma.tradingModel.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new AppError(404, 'Model not found', 'MODEL_NOT_FOUND');

  const data: Prisma.TradingModelUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.rules !== undefined) data.rules = input.rules;
  if (input.status !== undefined) data.status = input.status;

  try {
    const updated = await prisma.tradingModel.update({ where: { id }, data });
    return toModelDto(updated);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, `A model named "${input.name}" already exists`, 'MODEL_EXISTS');
    }
    throw err;
  }
}

export async function deleteModel(userId: string, id: string): Promise<void> {
  const existing = await prisma.tradingModel.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new AppError(404, 'Model not found', 'MODEL_NOT_FOUND');
  await prisma.tradingModel.delete({ where: { id } });
}

import { prisma } from '@core/db/prisma';

// ─────────────────────────────────────────────────────────────────────────────
// First-login seeding. A new user starts with the three default trading models
// and the six default pairs so the Add-Trade form and System tab are usable
// immediately. Accounts / trades / planned trades start empty (real data only).
//
// Idempotent: each entity type is seeded only when the user has none, and the
// (userId, name)/(userId, symbol) unique constraints + skipDuplicates make
// concurrent first requests safe.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODELS = [
  {
    name: '4HPullBack',
    description: 'Pullback to key level on higher timeframe with EMA confirmation.',
    rules:
      'Wait for significant pullback on HTF. Price reacts to key support (daily fib 0.5/0.618 + technical level). Multiple touches required — base formation. Descending channel must be broken or weakened. Price closes above both 4H 50 EMA and 1H 50 EMA — entry trigger.',
    status: 'Active',
  },
  {
    name: 'Breakout',
    description: 'Organic consolidation near key level, breakout candle close as entry.',
    rules:
      'Price consolidates organically near key level for multiple candles. Not a news spike. Base formation mandatory. EMAs supporting from below. Correlated pair must confirm — if GBPUSD breaks out, EURUSD should align. Entry on breakout candle close.',
    status: 'Active',
  },
  {
    name: 'Short',
    description: 'Mirror of Breakout — rejection from EMA at resistance, breakdown entry.',
    rules:
      'Price at major resistance. Shoots up into level. EMA above acts as ceiling. Rejection occurs. Breaks down through level. Enter on breakdown candle close. Falls are faster than rallies — timing critical.',
    status: 'Active',
  },
] as const;

const DEFAULT_PAIRS = [
  { symbol: 'EURUSD', displayName: 'EUR/USD', flagA: '🇪🇺', flagB: '🇺🇸', pipValue: 10, status: 'Active' },
  { symbol: 'GBPUSD', displayName: 'GBP/USD', flagA: '🇬🇧', flagB: '🇺🇸', pipValue: 10, status: 'Active' },
  { symbol: 'USDJPY', displayName: 'USD/JPY', flagA: '🇺🇸', flagB: '🇯🇵', pipValue: 9.5, status: 'Active' },
  { symbol: 'EURJPY', displayName: 'EUR/JPY', flagA: '🇪🇺', flagB: '🇯🇵', pipValue: 9.5, status: 'Active' },
  { symbol: 'GBPJPY', displayName: 'GBP/JPY', flagA: '🇬🇧', flagB: '🇯🇵', pipValue: 9.5, status: 'Active' },
  { symbol: 'XAUUSD', displayName: 'Gold', flagA: '🥇', flagB: '🇺🇸', pipValue: 1, status: 'Active' },
] as const;

export async function seedDefaultModelsIfNeeded(userId: string): Promise<void> {
  const count = await prisma.tradingModel.count({ where: { userId } });
  if (count > 0) return;
  await prisma.tradingModel.createMany({
    data: DEFAULT_MODELS.map((m) => ({ ...m, userId })),
    skipDuplicates: true,
  });
}

export async function seedDefaultPairsIfNeeded(userId: string): Promise<void> {
  const count = await prisma.tradingPair.count({ where: { userId } });
  if (count > 0) return;
  await prisma.tradingPair.createMany({
    data: DEFAULT_PAIRS.map((p) => ({ ...p, userId })),
    skipDuplicates: true,
  });
}

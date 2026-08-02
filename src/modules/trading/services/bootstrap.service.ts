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
  // Issue 3: the tradable Oracle instruments this list was missing — the
  // four AUD pairs and the three equity indices. Standalone currencies
  // (USD/EUR/GBP/JPY/AUD) are deliberately excluded — analysis subjects, not
  // tradable instruments. JPY-quote pairs keep the existing 9.5 convention;
  // non-JPY FX pairs keep the existing 10. The indices have no established
  // per-point convention anywhere in this codebase — 1 is a best-effort
  // placeholder matching Gold's (the one existing non-FX instrument) value,
  // not a verified point-value; report flags this for the user to confirm
  // via System → Pairs.
  { symbol: 'AUDUSD', displayName: 'AUD/USD', flagA: '🇦🇺', flagB: '🇺🇸', pipValue: 10, status: 'Active' },
  { symbol: 'AUDJPY', displayName: 'AUD/JPY', flagA: '🇦🇺', flagB: '🇯🇵', pipValue: 9.5, status: 'Active' },
  { symbol: 'EURAUD', displayName: 'EUR/AUD', flagA: '🇪🇺', flagB: '🇦🇺', pipValue: 10, status: 'Active' },
  { symbol: 'GBPAUD', displayName: 'GBP/AUD', flagA: '🇬🇧', flagB: '🇦🇺', pipValue: 10, status: 'Active' },
  { symbol: 'SPY', displayName: 'S&P 500 ETF', flagA: '📈', flagB: '🇺🇸', pipValue: 1, status: 'Active' },
  { symbol: 'NAS100', displayName: 'NASDAQ 100', flagA: '💻', flagB: '🇺🇸', pipValue: 1, status: 'Active' },
  { symbol: 'US30', displayName: 'Dow Jones 30', flagA: '📊', flagB: '🇺🇸', pipValue: 1, status: 'Active' },
] as const;

// Issue 3: the seven symbols added above, split out so the backfill below can
// top up an EXISTING user's pairs without touching the original six — a user
// may have already customized or deliberately deleted one of those, and
// re-seeding them would silently undo that. Only ever adds; never updates or
// deletes a row that exists.
const NEWLY_ADDED_SYMBOLS = new Set([
  'AUDUSD', 'AUDJPY', 'EURAUD', 'GBPAUD', 'SPY', 'NAS100', 'US30',
]);

export async function seedDefaultModelsIfNeeded(userId: string): Promise<void> {
  const count = await prisma.tradingModel.count({ where: { userId } });
  if (count > 0) return;
  await prisma.tradingModel.createMany({
    data: DEFAULT_MODELS.map((m) => ({ ...m, userId })),
    skipDuplicates: true,
  });
}

export async function seedDefaultPairsIfNeeded(userId: string): Promise<void> {
  const existing = await prisma.tradingPair.findMany({
    where: { userId },
    select: { symbol: true },
  });

  if (existing.length === 0) {
    // Brand-new user: full default set, unchanged mechanism.
    await prisma.tradingPair.createMany({
      data: DEFAULT_PAIRS.map((p) => ({ ...p, userId })),
      skipDuplicates: true,
    });
    return;
  }

  // Issue 3: existing user — top up ONLY the newly-added instruments they
  // don't already have. Never touches an existing row (no update, no
  // delete), and never re-adds one of the original six defaults even if the
  // user removed it — that would silently undo a deliberate choice.
  const existingSymbols = new Set(existing.map((p) => p.symbol));
  const missing = DEFAULT_PAIRS.filter(
    (p) => NEWLY_ADDED_SYMBOLS.has(p.symbol) && !existingSymbols.has(p.symbol),
  );
  if (missing.length === 0) return;
  await prisma.tradingPair.createMany({
    data: missing.map((p) => ({ ...p, userId })),
    skipDuplicates: true,
  });
}

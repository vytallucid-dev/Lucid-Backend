import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

type CotRow = {
  id: string;
  assetId: string;
  contractCode: string;
  reportDate: Date;
  releaseDate: Date;
  traderCategory: string;
  longContracts: number;
  shortContracts: number;
  longPct: Prisma.Decimal | null;
  shortPct: Prisma.Decimal | null;
  changeInLongContracts: number;
  changeInShortContracts: number;
  changeInLongPct: Prisma.Decimal | null;
  changeInShortPct: Prisma.Decimal | null;
  weeklyChangePct: Prisma.Decimal | null;
  netPositioningLabel: string;
  changeLabel: string;
  isCurrent: boolean;
};

const storage: { rows: CotRow[]; nextId: number } = { rows: [], nextId: 1 };

const txCotDataMock = {
  findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return (
      storage.rows.find(
        (r) =>
          r.contractCode === where.contractCode &&
          (r.reportDate as Date).getTime() === (where.reportDate as Date).getTime() &&
          r.traderCategory === where.traderCategory &&
          r.isCurrent === where.isCurrent,
      ) ?? null
    );
  }),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<CotRow> }) => {
    const row = storage.rows.find((r) => r.id === where.id);
    if (!row) throw new Error('not found');
    Object.assign(row, data);
    return row;
  }),
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const id = `cot-${storage.nextId++}`;
    const row: CotRow = {
      id,
      assetId: data.assetId as string,
      contractCode: data.contractCode as string,
      reportDate: data.reportDate as Date,
      releaseDate: data.releaseDate as Date,
      traderCategory: data.traderCategory as string,
      longContracts: data.longContracts as number,
      shortContracts: data.shortContracts as number,
      longPct: (data.longPct as Prisma.Decimal | null) ?? null,
      shortPct: (data.shortPct as Prisma.Decimal | null) ?? null,
      changeInLongContracts: data.changeInLongContracts as number,
      changeInShortContracts: data.changeInShortContracts as number,
      changeInLongPct: (data.changeInLongPct as Prisma.Decimal | null) ?? null,
      changeInShortPct: (data.changeInShortPct as Prisma.Decimal | null) ?? null,
      weeklyChangePct: (data.weeklyChangePct as Prisma.Decimal | null) ?? null,
      netPositioningLabel: data.netPositioningLabel as string,
      changeLabel: data.changeLabel as string,
      isCurrent: (data.isCurrent as boolean) ?? true,
    };
    storage.rows.push(row);
    return row;
  }),
};

vi.mock('@core/db/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      return cb({ cotData: txCotDataMock });
    }),
  },
}));

import { cotDataRepository } from '@core/repositories/cot-data.repository';

const REPORT_DATE = new Date(Date.UTC(2026, 4, 13));
const RELEASE_DATE = new Date(Date.UTC(2026, 4, 16));

function baseInput(
  overrides: Partial<Parameters<typeof cotDataRepository.upsert>[0]> = {},
): Parameters<typeof cotDataRepository.upsert>[0] {
  return {
    assetId: 'asset-usd',
    contractCode: '098662',
    reportDate: REPORT_DATE,
    releaseDate: RELEASE_DATE,
    traderCategory: 'Non-Commercials',
    longContracts: 40000,
    shortContracts: 30000,
    longPct: 57.1429,
    shortPct: 42.8571,
    changeInLongContracts: 1000,
    changeInShortContracts: -500,
    changeInLongPct: 2.5641,
    changeInShortPct: -1.6393,
    weeklyChangePct: 4.2034,
    netPositioningLabel: 'Bullish',
    changeLabel: 'Bullish',
    source: 'cftc',
    rawPayload: { foo: 'bar' },
    ...overrides,
  };
}

describe('cotDataRepository.upsert', () => {
  beforeEach(() => {
    storage.rows = [];
    storage.nextId = 1;
    vi.clearAllMocks();
  });

  it('inserts a fresh row when none exists', async () => {
    const result = await cotDataRepository.upsert(baseInput());
    expect(result.action).toBe('inserted');
    expect(storage.rows).toHaveLength(1);
    expect(storage.rows[0].isCurrent).toBe(true);
    expect(storage.rows[0].longContracts).toBe(40000);
  });

  it('returns skipped on identical re-run', async () => {
    await cotDataRepository.upsert(baseInput());
    const result = await cotDataRepository.upsert(baseInput());
    expect(result.action).toBe('skipped');
    expect(storage.rows).toHaveLength(1);
  });

  it('treats values rounding to identical 4-decimal Decimal as a match', async () => {
    await cotDataRepository.upsert(baseInput({ longPct: 57.142912345 }));
    const result = await cotDataRepository.upsert(
      baseInput({ longPct: 57.142887654 }),
    );
    expect(result.action).toBe('skipped');
  });

  it('flips prior row and inserts new vintage when values differ', async () => {
    await cotDataRepository.upsert(baseInput({ longContracts: 40000 }));
    const result = await cotDataRepository.upsert(
      baseInput({ longContracts: 41500 }),
    );
    expect(result.action).toBe('revised');
    expect(storage.rows).toHaveLength(2);
    const oldRow = storage.rows.find((r) => r.longContracts === 40000);
    const newRow = storage.rows.find((r) => r.longContracts === 41500);
    expect(oldRow?.isCurrent).toBe(false);
    expect(newRow?.isCurrent).toBe(true);
  });

  it('detects label changes as revisions', async () => {
    await cotDataRepository.upsert(baseInput({ netPositioningLabel: 'Bullish' }));
    const result = await cotDataRepository.upsert(
      baseInput({ netPositioningLabel: 'Neutral' }),
    );
    expect(result.action).toBe('revised');
  });
});

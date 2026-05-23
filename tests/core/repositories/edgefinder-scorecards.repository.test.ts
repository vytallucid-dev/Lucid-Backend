import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

type Row = {
  id: string;
  assetId: string;
  observationDate: Date;
  baseFundamentalsScore: number;
  fundamentalsScore: number;
  cotScore: number;
  compassAdjustment: number;
  compassOverridesApplied: unknown | null;
  regimeAtCompute: string | null;
  totalScore: number;
  ratingLabel: string;
  indicatorBreakdown: unknown;
  cotBreakdown: unknown | null;
  isCurrent: boolean;
};

const storage: { rows: Row[]; nextId: number } = { rows: [], nextId: 1 };

const txMock = {
  findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return (
      storage.rows.find(
        (r) =>
          r.assetId === where.assetId &&
          (r.observationDate as Date).getTime() ===
            (where.observationDate as Date).getTime() &&
          r.isCurrent === where.isCurrent,
      ) ?? null
    );
  }),
  update: vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = storage.rows.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  ),
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const id = `sc-${storage.nextId++}`;
    // Mimic Prisma reads: Prisma.JsonNull values come back as JS null on read.
    const normalizeJsonNull = (v: unknown): unknown =>
      v === Prisma.JsonNull || v === Prisma.DbNull ? null : v;
    const row: Row = {
      id,
      assetId: data.assetId as string,
      observationDate: data.observationDate as Date,
      baseFundamentalsScore: data.baseFundamentalsScore as number,
      fundamentalsScore: data.fundamentalsScore as number,
      cotScore: data.cotScore as number,
      compassAdjustment: data.compassAdjustment as number,
      compassOverridesApplied: normalizeJsonNull(data.compassOverridesApplied) ?? null,
      regimeAtCompute: (data.regimeAtCompute as string | null) ?? null,
      totalScore: data.totalScore as number,
      ratingLabel: data.ratingLabel as string,
      indicatorBreakdown: data.indicatorBreakdown,
      cotBreakdown: normalizeJsonNull(data.cotBreakdown) ?? null,
      isCurrent: (data.isCurrent as boolean) ?? true,
    };
    storage.rows.push(row);
    return row;
  }),
};

vi.mock('@core/db/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      return cb({ edgefinderScorecard: txMock });
    }),
    edgefinderScorecard: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          return (
            storage.rows.find(
              (r) =>
                r.assetId === where.assetId &&
                (r.observationDate as Date).getTime() ===
                  (where.observationDate as Date).getTime() &&
                r.isCurrent === where.isCurrent,
            ) ?? null
          );
        },
      ),
    },
  },
}));

import { edgefinderScorecardsRepository } from '@core/repositories/edgefinder-scorecards.repository';

const DATE = new Date(Date.UTC(2026, 4, 19));

function baseInput(
  overrides: Partial<Parameters<typeof edgefinderScorecardsRepository.upsert>[0]> = {},
): Parameters<typeof edgefinderScorecardsRepository.upsert>[0] {
  return {
    assetId: 'asset-usd',
    observationDate: DATE,
    baseFundamentalsScore: 2,
    fundamentalsScore: 2,
    cotScore: 1,
    compassAdjustment: 0,
    compassOverridesApplied: null,
    regimeAtCompute: 'Caution',
    totalScore: 3,
    ratingLabel: 'Support',
    indicatorBreakdown: [{ indicatorCode: 'US_GDP_QOQ', score: 1 }],
    cotBreakdown: { score: 1, netLabel: 'Bullish' },
    ...overrides,
  };
}

describe('edgefinderScorecardsRepository.upsert', () => {
  beforeEach(() => {
    storage.rows = [];
    storage.nextId = 1;
    vi.clearAllMocks();
  });

  it('inserts a fresh row when none exists', async () => {
    const r = await edgefinderScorecardsRepository.upsert(baseInput());
    expect(r.action).toBe('inserted');
    expect(storage.rows).toHaveLength(1);
    expect(storage.rows[0].isCurrent).toBe(true);
    expect(storage.rows[0].totalScore).toBe(3);
  });

  it('returns skipped on identical re-run', async () => {
    await edgefinderScorecardsRepository.upsert(baseInput());
    const r = await edgefinderScorecardsRepository.upsert(baseInput());
    expect(r.action).toBe('skipped');
    expect(storage.rows).toHaveLength(1);
  });

  it('detects totalScore change as revision', async () => {
    await edgefinderScorecardsRepository.upsert(baseInput({ totalScore: 3 }));
    const r = await edgefinderScorecardsRepository.upsert(
      baseInput({ totalScore: 4, ratingLabel: 'Very Support' }),
    );
    expect(r.action).toBe('revised');
    expect(storage.rows).toHaveLength(2);
    expect(storage.rows.find((x) => x.totalScore === 3)?.isCurrent).toBe(false);
    expect(storage.rows.find((x) => x.totalScore === 4)?.isCurrent).toBe(true);
  });

  it('detects indicatorBreakdown change as revision', async () => {
    await edgefinderScorecardsRepository.upsert(baseInput());
    const r = await edgefinderScorecardsRepository.upsert(
      baseInput({ indicatorBreakdown: [{ indicatorCode: 'US_NFP', score: 0 }] }),
    );
    expect(r.action).toBe('revised');
  });

  it('detects regimeAtCompute change as revision', async () => {
    await edgefinderScorecardsRepository.upsert(baseInput({ regimeAtCompute: 'Caution' }));
    const r = await edgefinderScorecardsRepository.upsert(
      baseInput({ regimeAtCompute: 'Risk-Off' }),
    );
    expect(r.action).toBe('revised');
  });
});

describe('edgefinderScorecardsRepository.getCurrent', () => {
  beforeEach(() => {
    storage.rows = [];
    storage.nextId = 1;
    vi.clearAllMocks();
  });

  it('returns null when no current row exists', async () => {
    const r = await edgefinderScorecardsRepository.getCurrent('asset-usd', DATE);
    expect(r).toBeNull();
  });

  it('returns the isCurrent=true row', async () => {
    await edgefinderScorecardsRepository.upsert(baseInput({ totalScore: 5 }));
    const r = await edgefinderScorecardsRepository.getCurrent('asset-usd', DATE);
    expect(r?.totalScore).toBe(5);
  });
});

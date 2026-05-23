import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

type Row = {
  id: string;
  pairId: string;
  scoreDate: Date;
  basePairScore: number;
  pairCotScore: number;
  baseTotal: number;
  compassAdjustment: number;
  compassOverridesApplied: unknown | null;
  regimeAtCompute: string | null;
  totalScore: number;
  ratingLabel: string;
  rowBreakdown: unknown;
  cotBreakdown: unknown | null;
  isCurrent: boolean;
};

const storage: { rows: Row[]; nextId: number } = { rows: [], nextId: 1 };

const txMock = {
  findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return (
      storage.rows.find(
        (r) =>
          r.pairId === where.pairId &&
          (r.scoreDate as Date).getTime() === (where.scoreDate as Date).getTime() &&
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
    const id = `ps-${storage.nextId++}`;
    const normalizeJsonNull = (v: unknown): unknown =>
      v === Prisma.JsonNull || v === Prisma.DbNull ? null : v;
    const row: Row = {
      id,
      pairId: data.pairId as string,
      scoreDate: data.scoreDate as Date,
      basePairScore: data.basePairScore as number,
      pairCotScore: data.pairCotScore as number,
      baseTotal: data.baseTotal as number,
      compassAdjustment: data.compassAdjustment as number,
      compassOverridesApplied: normalizeJsonNull(data.compassOverridesApplied) ?? null,
      regimeAtCompute: (data.regimeAtCompute as string | null) ?? null,
      totalScore: data.totalScore as number,
      ratingLabel: data.ratingLabel as string,
      rowBreakdown: data.rowBreakdown,
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
      return cb({ edgefinderPairScore: txMock });
    }),
    edgefinderPairScore: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return (
          storage.rows.find(
            (r) =>
              r.pairId === where.pairId &&
              (r.scoreDate as Date).getTime() === (where.scoreDate as Date).getTime() &&
              r.isCurrent === where.isCurrent,
          ) ?? null
        );
      }),
    },
  },
}));

import { edgefinderPairScoresRepository } from '@core/repositories/edgefinder-pair-scores.repository';

const DATE = new Date(Date.UTC(2026, 4, 19));

function baseInput(
  overrides: Partial<Parameters<typeof edgefinderPairScoresRepository.upsert>[0]> = {},
): Parameters<typeof edgefinderPairScoresRepository.upsert>[0] {
  return {
    pairId: 'asset-eurusd',
    scoreDate: DATE,
    basePairScore: -7,
    pairCotScore: -1,
    baseTotal: -8,
    compassAdjustment: 0,
    compassOverridesApplied: null,
    regimeAtCompute: 'Caution',
    totalScore: -8,
    ratingLabel: 'Very Weak',
    rowBreakdown: [{ rowName: 'GDP', pairScore: 0 }],
    cotBreakdown: { pairCotScore: -1 },
    ...overrides,
  };
}

describe('edgefinderPairScoresRepository.upsert', () => {
  beforeEach(() => {
    storage.rows = [];
    storage.nextId = 1;
    vi.clearAllMocks();
  });

  it('inserts a fresh row when none exists', async () => {
    const r = await edgefinderPairScoresRepository.upsert(baseInput());
    expect(r.action).toBe('inserted');
    expect(storage.rows).toHaveLength(1);
    expect(storage.rows[0].isCurrent).toBe(true);
    expect(storage.rows[0].totalScore).toBe(-8);
  });

  it('returns skipped on identical re-run', async () => {
    await edgefinderPairScoresRepository.upsert(baseInput());
    const r = await edgefinderPairScoresRepository.upsert(baseInput());
    expect(r.action).toBe('skipped');
    expect(storage.rows).toHaveLength(1);
  });

  it('detects totalScore change as revision and flips prior isCurrent', async () => {
    await edgefinderPairScoresRepository.upsert(baseInput({ totalScore: -8 }));
    const r = await edgefinderPairScoresRepository.upsert(
      baseInput({ totalScore: -9, ratingLabel: 'Very Weak' }),
    );
    expect(r.action).toBe('revised');
    expect(storage.rows).toHaveLength(2);
    expect(storage.rows.find((x) => x.totalScore === -8)?.isCurrent).toBe(false);
    expect(storage.rows.find((x) => x.totalScore === -9)?.isCurrent).toBe(true);
  });

  it('detects rowBreakdown JSON change as revision', async () => {
    await edgefinderPairScoresRepository.upsert(baseInput());
    const r = await edgefinderPairScoresRepository.upsert(
      baseInput({ rowBreakdown: [{ rowName: 'CPI', pairScore: 1 }] }),
    );
    expect(r.action).toBe('revised');
  });

  it('detects regimeAtCompute change as revision', async () => {
    await edgefinderPairScoresRepository.upsert(baseInput({ regimeAtCompute: 'Caution' }));
    const r = await edgefinderPairScoresRepository.upsert(
      baseInput({ regimeAtCompute: 'Risk-Off' }),
    );
    expect(r.action).toBe('revised');
  });

  it('detects compassOverridesApplied JSON change as revision', async () => {
    await edgefinderPairScoresRepository.upsert(baseInput({ compassOverridesApplied: null }));
    const r = await edgefinderPairScoresRepository.upsert(
      baseInput({
        compassOverridesApplied: { regime: 'Risk-Off', totalAdjustment: -1 },
      }),
    );
    expect(r.action).toBe('revised');
  });
});

describe('edgefinderPairScoresRepository.getCurrent', () => {
  beforeEach(() => {
    storage.rows = [];
    storage.nextId = 1;
    vi.clearAllMocks();
  });

  it('returns null when no current row exists', async () => {
    const r = await edgefinderPairScoresRepository.getCurrent('asset-eurusd', DATE);
    expect(r).toBeNull();
  });

  it('returns the isCurrent=true row', async () => {
    await edgefinderPairScoresRepository.upsert(baseInput({ totalScore: -5 }));
    const r = await edgefinderPairScoresRepository.getCurrent('asset-eurusd', DATE);
    expect(r?.totalScore).toBe(-5);
    expect(r?.ratingLabel).toBe('Very Weak');
  });
});

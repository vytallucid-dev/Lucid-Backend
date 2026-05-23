import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

type ClassificationRow = {
  id: string;
  classificationDate: Date;
  candidateRegime: string;
  activeRegime: string;
  persistenceDaysCount: number;
  crisisOverrideFired: boolean;
  totalGreenWeight: Prisma.Decimal;
  totalYellowWeight: Prisma.Decimal;
  totalRedWeight: Prisma.Decimal;
  voteBreakdown: unknown;
  isCurrent: boolean;
  isValidation: boolean;
};

const storage: { rows: ClassificationRow[]; nextId: number } = {
  rows: [],
  nextId: 1,
};

const txMock = {
  findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const isValidationFilter = (where.isValidation as boolean | undefined) ?? false;
    return (
      storage.rows.find(
        (r) =>
          (r.classificationDate as Date).getTime() ===
            (where.classificationDate as Date).getTime() &&
          r.isCurrent === where.isCurrent &&
          r.isValidation === isValidationFilter,
      ) ?? null
    );
  }),
  update: vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<ClassificationRow> }) => {
      const row = storage.rows.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  ),
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const id = `cc-${storage.nextId++}`;
    const row: ClassificationRow = {
      id,
      classificationDate: data.classificationDate as Date,
      candidateRegime: data.candidateRegime as string,
      activeRegime: data.activeRegime as string,
      persistenceDaysCount: data.persistenceDaysCount as number,
      crisisOverrideFired: data.crisisOverrideFired as boolean,
      totalGreenWeight: data.totalGreenWeight as Prisma.Decimal,
      totalYellowWeight: data.totalYellowWeight as Prisma.Decimal,
      totalRedWeight: data.totalRedWeight as Prisma.Decimal,
      voteBreakdown: data.voteBreakdown,
      isCurrent: (data.isCurrent as boolean) ?? true,
      isValidation: (data.isValidation as boolean) ?? false,
    };
    storage.rows.push(row);
    return row;
  }),
};

vi.mock('@core/db/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      return cb({ compassClassification: txMock });
    }),
    compassClassification: {
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: {
            isCurrent?: boolean;
            isValidation?: boolean;
            classificationDate?: { lt?: Date; lte?: Date };
          };
          orderBy: unknown;
        }) => {
          void orderBy;
          const isValidationFilter = where.isValidation ?? false;
          const eligible = storage.rows.filter(
            (r) =>
              r.isCurrent === where.isCurrent &&
              r.isValidation === isValidationFilter &&
              (where.classificationDate?.lt
                ? (r.classificationDate as Date).getTime() <
                  where.classificationDate.lt.getTime()
                : true) &&
              (where.classificationDate?.lte
                ? (r.classificationDate as Date).getTime() <=
                  where.classificationDate.lte.getTime()
                : true),
          );
          eligible.sort(
            (a, b) =>
              (b.classificationDate as Date).getTime() -
              (a.classificationDate as Date).getTime(),
          );
          return eligible[0] ?? null;
        },
      ),
    },
  },
}));

import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';

const DATE = new Date(Date.UTC(2026, 4, 19));

function baseInput(
  overrides: Partial<Parameters<typeof compassClassificationsRepository.upsert>[0]> = {},
): Parameters<typeof compassClassificationsRepository.upsert>[0] {
  return {
    classificationDate: DATE,
    candidateRegime: 'Caution',
    activeRegime: 'Caution',
    persistenceDaysCount: 0,
    crisisOverrideFired: false,
    totalGreenWeight: 2.5,
    totalYellowWeight: 3.5,
    totalRedWeight: 2.0,
    voteBreakdown: { inputs: {}, crisis: { fired: false } },
    ...overrides,
  };
}

describe('compassClassificationsRepository.upsert', () => {
  beforeEach(() => {
    storage.rows = [];
    storage.nextId = 1;
    vi.clearAllMocks();
  });

  it('inserts a fresh row when none exists', async () => {
    const result = await compassClassificationsRepository.upsert(baseInput());
    expect(result.action).toBe('inserted');
    expect(storage.rows).toHaveLength(1);
    expect(storage.rows[0].isCurrent).toBe(true);
    expect(storage.rows[0].candidateRegime).toBe('Caution');
  });

  it('returns skipped on identical re-run', async () => {
    await compassClassificationsRepository.upsert(baseInput());
    const result = await compassClassificationsRepository.upsert(baseInput());
    expect(result.action).toBe('skipped');
    expect(storage.rows).toHaveLength(1);
  });

  it('flips prior row and inserts new vintage when active regime differs', async () => {
    await compassClassificationsRepository.upsert(baseInput({ activeRegime: 'Caution' }));
    const result = await compassClassificationsRepository.upsert(
      baseInput({ activeRegime: 'Risk-Off' }),
    );
    expect(result.action).toBe('revised');
    expect(storage.rows).toHaveLength(2);
    const oldRow = storage.rows.find((r) => r.activeRegime === 'Caution');
    const newRow = storage.rows.find((r) => r.activeRegime === 'Risk-Off');
    expect(oldRow?.isCurrent).toBe(false);
    expect(newRow?.isCurrent).toBe(true);
  });

  it('treats weights rounding to identical Decimal(5,2) as a match', async () => {
    await compassClassificationsRepository.upsert(
      baseInput({ totalGreenWeight: 2.501 }),
    );
    const result = await compassClassificationsRepository.upsert(
      baseInput({ totalGreenWeight: 2.4951 }),
    );
    expect(result.action).toBe('skipped');
  });

  it('detects persistenceDaysCount changes as revisions', async () => {
    await compassClassificationsRepository.upsert(baseInput({ persistenceDaysCount: 1 }));
    const result = await compassClassificationsRepository.upsert(
      baseInput({ persistenceDaysCount: 2 }),
    );
    expect(result.action).toBe('revised');
  });

  it('detects voteBreakdown changes as revisions', async () => {
    await compassClassificationsRepository.upsert(
      baseInput({ voteBreakdown: { foo: 'a' } }),
    );
    const result = await compassClassificationsRepository.upsert(
      baseInput({ voteBreakdown: { foo: 'b' } }),
    );
    expect(result.action).toBe('revised');
  });
});

describe('compassClassificationsRepository.getMostRecentBefore', () => {
  beforeEach(() => {
    storage.rows = [];
    storage.nextId = 1;
    vi.clearAllMocks();
  });

  it('returns null when no prior row exists', async () => {
    const result = await compassClassificationsRepository.getMostRecentBefore(DATE);
    expect(result).toBeNull();
  });

  it('returns the most recent current row before the given date', async () => {
    storage.rows.push(
      {
        id: 'a',
        classificationDate: new Date(Date.UTC(2026, 4, 14)),
        candidateRegime: 'Risk-Off',
        activeRegime: 'Caution',
        persistenceDaysCount: 1,
        crisisOverrideFired: false,
        totalGreenWeight: new Prisma.Decimal(0),
        totalYellowWeight: new Prisma.Decimal(0),
        totalRedWeight: new Prisma.Decimal(0),
        voteBreakdown: {},
        isCurrent: true,
        isValidation: false,
      },
      {
        id: 'b',
        classificationDate: new Date(Date.UTC(2026, 4, 18)),
        candidateRegime: 'Risk-Off',
        activeRegime: 'Caution',
        persistenceDaysCount: 3,
        crisisOverrideFired: false,
        totalGreenWeight: new Prisma.Decimal(0),
        totalYellowWeight: new Prisma.Decimal(0),
        totalRedWeight: new Prisma.Decimal(0),
        voteBreakdown: {},
        isCurrent: true,
        isValidation: false,
      },
    );
    const result = await compassClassificationsRepository.getMostRecentBefore(DATE);
    expect(result?.persistenceDaysCount).toBe(3);
    expect(result?.activeRegime).toBe('Caution');
  });

  it('ignores rows with isCurrent=false', async () => {
    storage.rows.push({
      id: 'a',
      classificationDate: new Date(Date.UTC(2026, 4, 18)),
      candidateRegime: 'Risk-Off',
      activeRegime: 'Caution',
      persistenceDaysCount: 2,
      crisisOverrideFired: false,
      totalGreenWeight: new Prisma.Decimal(0),
      totalYellowWeight: new Prisma.Decimal(0),
      totalRedWeight: new Prisma.Decimal(0),
      voteBreakdown: {},
      isCurrent: false,
      isValidation: false,
    });
    const result = await compassClassificationsRepository.getMostRecentBefore(DATE);
    expect(result).toBeNull();
  });

  it('excludes rows on the given date itself (strictly before)', async () => {
    storage.rows.push({
      id: 'a',
      classificationDate: DATE,
      candidateRegime: 'Risk-Off',
      activeRegime: 'Caution',
      persistenceDaysCount: 2,
      crisisOverrideFired: false,
      totalGreenWeight: new Prisma.Decimal(0),
      totalYellowWeight: new Prisma.Decimal(0),
      totalRedWeight: new Prisma.Decimal(0),
      voteBreakdown: {},
      isCurrent: true,
      isValidation: false,
    });
    const result = await compassClassificationsRepository.getMostRecentBefore(DATE);
    expect(result).toBeNull();
  });
});

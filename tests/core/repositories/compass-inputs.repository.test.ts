import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

type Row = {
  id: string;
  observationDate: Date;
  inputCode: string;
  rawValue: Prisma.Decimal | null;
  derivedValue: Prisma.Decimal | null;
  colorBand: string;
  subChecks: unknown;
  source: string;
  isValidation: boolean;
  computedAt: Date;
};

const storage: { rows: Row[]; nextId: number } = { rows: [], nextId: 1 };

const txCompassMock = {
  findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const composite = where.observationDate_inputCode_isValidation as
      | { observationDate: Date; inputCode: string; isValidation: boolean }
      | undefined;
    if (!composite) return null;
    return (
      storage.rows.find(
        (r) =>
          r.observationDate.getTime() === composite.observationDate.getTime() &&
          r.inputCode === composite.inputCode &&
          r.isValidation === composite.isValidation,
      ) ?? null
    );
  }),
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const id = `ci-${storage.nextId++}`;
    // Real Prisma persists Prisma.JsonNull as DB null and returns JS null on
    // read. The mock mirrors that so equality checks behave as in production.
    const raw = data.subChecks;
    const normalizedSubChecks =
      raw === Prisma.JsonNull || raw === Prisma.DbNull || raw === undefined ? null : raw;
    const row: Row = {
      id,
      observationDate: data.observationDate as Date,
      inputCode: data.inputCode as string,
      rawValue: (data.rawValue as Prisma.Decimal | null) ?? null,
      derivedValue: (data.derivedValue as Prisma.Decimal | null) ?? null,
      colorBand: data.colorBand as string,
      subChecks: normalizedSubChecks,
      source: data.source as string,
      isValidation: (data.isValidation as boolean) ?? false,
      computedAt: new Date(),
    };
    storage.rows.push(row);
    return row;
  }),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const row = storage.rows.find((r) => r.id === where.id);
    if (!row) throw new Error('not found');
    Object.assign(row, data);
    return row;
  }),
};

vi.mock('@core/db/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      return cb({ compassInput: txCompassMock });
    }),
  },
}));

import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';

const DATE = new Date(Date.UTC(2026, 4, 18));

describe('compassInputsRepository.upsert', () => {
  beforeEach(() => {
    storage.rows = [];
    storage.nextId = 1;
    vi.clearAllMocks();
  });

  it('inserts when no prior row exists', async () => {
    const result = await compassInputsRepository.upsert({
      observationDate: DATE,
      inputCode: 'VIX_5D_AVG',
      rawValue: 16.4,
      derivedValue: 16.2,
      colorBand: 'GREEN',
      subChecks: { closes: [16, 16.5, 16.1, 16.2, 16.4] },
      source: 'yahoo',
    });
    expect(result.action).toBe('inserted');
    expect(storage.rows).toHaveLength(1);
  });

  it('skips identical re-run', async () => {
    const input = {
      observationDate: DATE,
      inputCode: 'VIX_5D_AVG' as const,
      rawValue: 16.4,
      derivedValue: 16.2,
      colorBand: 'GREEN' as const,
      subChecks: { closes: [16, 16.5, 16.1, 16.2, 16.4] } as Prisma.InputJsonValue,
      source: 'yahoo' as const,
    };
    await compassInputsRepository.upsert(input);
    const result = await compassInputsRepository.upsert(input);
    expect(result.action).toBe('skipped');
    expect(storage.rows).toHaveLength(1);
  });

  it('updates in place when values differ', async () => {
    await compassInputsRepository.upsert({
      observationDate: DATE,
      inputCode: 'VIX_5D_AVG',
      rawValue: 16.4,
      derivedValue: 16.2,
      colorBand: 'GREEN',
      subChecks: { closes: [16, 16.5, 16.1, 16.2, 16.4] },
      source: 'yahoo',
    });
    const result = await compassInputsRepository.upsert({
      observationDate: DATE,
      inputCode: 'VIX_5D_AVG',
      rawValue: 18.2,
      derivedValue: 17.5,
      colorBand: 'YELLOW',
      subChecks: { closes: [16, 16.5, 17.0, 18.0, 18.2] },
      source: 'yahoo',
    });
    expect(result.action).toBe('updated');
    expect(storage.rows).toHaveLength(1);
    expect(storage.rows[0].colorBand).toBe('YELLOW');
  });

  it('treats sub-second decimal differences within 6 places as equal', async () => {
    await compassInputsRepository.upsert({
      observationDate: DATE,
      inputCode: 'HY_OAS',
      rawValue: 4.123456,
      derivedValue: 0.025,
      colorBand: 'GREEN',
      subChecks: null,
      source: 'fred',
    });
    const result = await compassInputsRepository.upsert({
      observationDate: DATE,
      inputCode: 'HY_OAS',
      rawValue: 4.1234561234,
      derivedValue: 0.025,
      colorBand: 'GREEN',
      subChecks: null,
      source: 'fred',
    });
    expect(result.action).toBe('skipped');
  });

  it('detects subChecks JSON changes as updates', async () => {
    await compassInputsRepository.upsert({
      observationDate: DATE,
      inputCode: 'US_DATA_STACK',
      rawValue: null,
      derivedValue: null,
      colorBand: 'GREEN',
      subChecks: { cpi: 'GREEN', gdp: 'GREEN', jobs: 'GREEN' },
      source: 'fred',
    });
    const result = await compassInputsRepository.upsert({
      observationDate: DATE,
      inputCode: 'US_DATA_STACK',
      rawValue: null,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: { cpi: 'YELLOW', gdp: 'GREEN', jobs: 'GREEN' },
      source: 'fred',
    });
    expect(result.action).toBe('updated');
  });
});

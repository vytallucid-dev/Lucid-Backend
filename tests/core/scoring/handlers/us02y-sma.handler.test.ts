import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    dataPoint: { findMany: vi.fn() },
  },
}));

import { prisma } from '@core/db/prisma';
import { us02ySmaHandler } from '@core/scoring/handlers/us02y-sma.handler';
import { ScoringContext } from '@core/scoring/types';

const mockedFindMany = prisma.dataPoint.findMany as unknown as ReturnType<typeof vi.fn>;

function ctx(observationDate = '2026-07-01'): ScoringContext {
  return {
    indicatorId: 'ind-1',
    indicatorCode: 'US_02Y_SMA',
    observationDate: new Date(observationDate),
    ruleVersionId: 'rule-1',
    ruleDefinition: { type: 'us02y_sma', flat_band_bp: 1 },
  };
}

interface RowFixture {
  id: string;
  value: number;
  observationDate: string;
}

/** Mocks findMany to return rows in the same desc-by-date order the handler queries for. */
function mockRows(rows: RowFixture[]): void {
  mockedFindMany.mockResolvedValueOnce(
    rows.map((r) => ({ id: r.id, value: r.value, observationDate: new Date(r.observationDate) })),
  );
}

describe('us02ySmaHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Rising (actual diagnosis fixture): SMA 4.092857 (06-24) -> 4.118571 (07-01), +2.57bp over 5 trading days -> score +1', async () => {
    // Real trending stretch from the diagnosis (2026-06-17..07-01): the 21-day
    // SMA climbed steadily ~+4.8bp over 10 trading days. The old day-over-day
    // handler read every one of these as FLAT/0; the 5-day horizon reads it
    // as RISING, matching ind9-bridge's scoreSmaDirection() on the same series.
    mockRows([
      { id: 'dp-07-01', value: 4.118571, observationDate: '2026-07-01' },
      { id: 'dp-06-30', value: 4.112857, observationDate: '2026-06-30' },
      { id: 'dp-06-29', value: 4.105238, observationDate: '2026-06-29' },
      { id: 'dp-06-26', value: 4.1, observationDate: '2026-06-26' },
      { id: 'dp-06-25', value: 4.096667, observationDate: '2026-06-25' },
      { id: 'dp-06-24', value: 4.092857, observationDate: '2026-06-24' },
    ]);
    const r = await us02ySmaHandler(ctx('2026-07-01'));
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(1);
      expect(r.metadata.direction).toBe('RISING');
      expect(Number(r.metadata.delta_bp)).toBeCloseTo(2.5714, 3);
      expect(r.metadata.lookback_trading_days).toBe(5);
      expect(r.metadata.prior_date).toBe('2026-06-24');
    }
  });

  it('Flat: 5-day change of 0.5bp (under the 1bp floor) -> score 0', async () => {
    mockRows([
      { id: 'dp-6', value: 4.525, observationDate: '2026-05-20' },
      { id: 'dp-5', value: 4.523, observationDate: '2026-05-19' },
      { id: 'dp-4', value: 4.522, observationDate: '2026-05-18' },
      { id: 'dp-3', value: 4.521, observationDate: '2026-05-15' },
      { id: 'dp-2', value: 4.520, observationDate: '2026-05-14' },
      { id: 'dp-1', value: 4.520, observationDate: '2026-05-13' },
    ]);
    const r = await us02ySmaHandler(ctx('2026-05-20'));
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.metadata.direction).toBe('FLAT');
      expect(Number(r.metadata.delta_bp)).toBeCloseTo(0.5, 5);
    }
  });

  it('Falling: 5-day change of -10bp (clears the floor) -> score -1', async () => {
    mockRows([
      { id: 'dp-6', value: 4.50, observationDate: '2026-05-20' },
      { id: 'dp-5', value: 4.52, observationDate: '2026-05-19' },
      { id: 'dp-4', value: 4.54, observationDate: '2026-05-18' },
      { id: 'dp-3', value: 4.56, observationDate: '2026-05-15' },
      { id: 'dp-2', value: 4.58, observationDate: '2026-05-14' },
      { id: 'dp-1', value: 4.60, observationDate: '2026-05-13' },
    ]);
    const r = await us02ySmaHandler(ctx('2026-05-20'));
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(-1);
      expect(r.metadata.direction).toBe('FALLING');
      expect(Number(r.metadata.delta_bp)).toBeCloseTo(-10, 5);
    }
  });

  it('Boundary: delta exactly +1bp -> FLAT (band is exclusive; > is required to score RISING)', async () => {
    mockRows([
      { id: 'dp-6', value: 4.53, observationDate: '2026-05-20' },
      { id: 'dp-5', value: 4.525, observationDate: '2026-05-19' },
      { id: 'dp-4', value: 4.525, observationDate: '2026-05-18' },
      { id: 'dp-3', value: 4.52, observationDate: '2026-05-15' },
      { id: 'dp-2', value: 4.52, observationDate: '2026-05-14' },
      { id: 'dp-1', value: 4.52, observationDate: '2026-05-13' },
    ]);
    const r = await us02ySmaHandler(ctx('2026-05-20'));
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(Number(r.metadata.delta_bp)).toBeCloseTo(1, 5);
      expect(r.score).toBe(0);
      expect(r.metadata.direction).toBe('FLAT');
    }
  });

  it('Boundary: delta exactly -1bp -> FLAT (band is exclusive; < is required to score FALLING)', async () => {
    mockRows([
      { id: 'dp-6', value: 4.51, observationDate: '2026-05-20' },
      { id: 'dp-5', value: 4.515, observationDate: '2026-05-19' },
      { id: 'dp-4', value: 4.515, observationDate: '2026-05-18' },
      { id: 'dp-3', value: 4.52, observationDate: '2026-05-15' },
      { id: 'dp-2', value: 4.52, observationDate: '2026-05-14' },
      { id: 'dp-1', value: 4.52, observationDate: '2026-05-13' },
    ]);
    const r = await us02ySmaHandler(ctx('2026-05-20'));
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(Number(r.metadata.delta_bp)).toBeCloseTo(-1, 5);
      expect(r.score).toBe(0);
      expect(r.metadata.direction).toBe('FLAT');
    }
  });

  it('No data at all -> insufficient_data, no score', async () => {
    mockRows([]);
    const r = await us02ySmaHandler(ctx());
    expect(r.kind).toBe('insufficient_data');
    if (r.kind === 'insufficient_data') {
      expect(r.reason).toMatch(/Need 6 stored SMA points/);
      expect(r.details).toMatchObject({ required: 6, found: 0 });
    }
    expect('score' in r).toBe(false);
  });

  it('Only 3 of 6 required points stored -> insufficient_data, no score (not defaulted to 0/FLAT)', async () => {
    mockRows([
      { id: 'dp-3', value: 4.52, observationDate: '2026-05-15' },
      { id: 'dp-2', value: 4.51, observationDate: '2026-05-14' },
      { id: 'dp-1', value: 4.50, observationDate: '2026-05-13' },
    ]);
    const r = await us02ySmaHandler(ctx('2026-05-15'));
    expect(r.kind).toBe('insufficient_data');
    if (r.kind === 'insufficient_data') {
      expect(r.reason).toMatch(/found 3/);
      expect(r.details).toMatchObject({ required: 6, found: 3 });
    }
    expect('score' in r).toBe(false);
  });
});

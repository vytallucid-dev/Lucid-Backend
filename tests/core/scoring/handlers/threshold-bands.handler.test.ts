import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    dataPoint: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '@core/db/prisma';
import { thresholdBandsHandler } from '@core/scoring/handlers/threshold-bands.handler';
import { ScoringContext } from '@core/scoring/types';

const mockedFindFirst = prisma.dataPoint.findFirst as unknown as ReturnType<typeof vi.fn>;

// Ind 13 (FII Long/Short — Index Futures) recalibrated bands. The stored value is a
// long-SHARE percentage on a 0-100 scale (long / (long + short) * 100). min is
// inclusive (>=), max is exclusive (<):
//   value >= 50        -> +1
//   28.6 <= value < 50 ->  0
//   value < 28.6       -> -1
const IND13_RULE = {
  type: 'threshold_bands',
  metric: 'long_pct',
  bands: [
    { min: 50.0, max: null, score: 1 },
    { min: 28.6, max: 50.0, score: 0 },
    { min: null, max: 28.6, score: -1 },
  ],
  cadence: 'daily',
  live_tracking_only: true,
  historical_default: 0,
};

function ctx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    indicatorId: 'ind-13',
    indicatorCode: 'IND_NIFTY_13_FII_LS_RATIO',
    observationDate: new Date('2026-06-19'),
    ruleVersionId: 'rule-1',
    ruleDefinition: IND13_RULE,
    ...overrides,
  };
}

function mockValue(value: number): void {
  mockedFindFirst.mockResolvedValueOnce({
    id: 'dp-1',
    value,
    observationDate: new Date('2026-06-19'),
  });
}

describe('thresholdBandsHandler — Ind 13 FII long-share bands (50 / 28.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Minimal required assertions: 55 -> +1, 40 -> 0, 25 -> -1 (share% scale)
  it('share 55 -> +1', async () => {
    mockValue(55);
    const r = await thresholdBandsHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(1);
  });

  it('share 40 -> 0', async () => {
    mockValue(40);
    const r = await thresholdBandsHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(0);
  });

  it('share 25 -> -1', async () => {
    mockValue(25);
    const r = await thresholdBandsHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(-1);
  });

  // Boundaries: min inclusive, max exclusive.
  it('share exactly 50 -> +1 (min inclusive)', async () => {
    mockValue(50);
    const r = await thresholdBandsHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(1);
  });

  it('share exactly 28.6 -> 0 (min inclusive, neutral floor)', async () => {
    mockValue(28.6);
    const r = await thresholdBandsHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(0);
  });

  // Current bearish regime: real stored values stay -1 under the new bands.
  it.each([12.954, 13.473, 9.692, 9.185])('regime value %s -> -1', async (value) => {
    mockValue(value);
    const r = await thresholdBandsHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') expect(r.score).toBe(-1);
  });

  it('no data point + live_tracking_only -> historical_default 0', async () => {
    mockedFindFirst.mockResolvedValueOnce(null);
    const r = await thresholdBandsHandler(ctx());
    expect(r.kind).toBe('scored');
    if (r.kind === 'scored') {
      expect(r.score).toBe(0);
      expect(r.flags).toContain('HISTORICAL_DEFAULT_NO_DATA');
    }
  });
});

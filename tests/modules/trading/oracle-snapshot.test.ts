import { describe, it, expect, vi, beforeEach } from 'vitest';

const findPairScore = vi.fn();
const findScorecard = vi.fn();
const findAsset = vi.fn();

vi.mock('@core/db/prisma', () => ({
  prisma: {
    asset: { findFirst: (...a: unknown[]) => findAsset(...a) },
    edgefinderPairScore: { findFirst: (...a: unknown[]) => findPairScore(...a) },
    edgefinderScorecard: { findFirst: (...a: unknown[]) => findScorecard(...a) },
  },
}));

vi.mock('@modules/edgefinder/api/instrument-registry', () => ({
  getInstrumentRegistry: async () => ({
    byCode: new Map<string, { code: string; assetClass: string; hasMapRows: boolean }>([
      ['EURUSD', { code: 'EURUSD', assetClass: 'forex_pair', hasMapRows: true }],
      ['XAUUSD', { code: 'XAUUSD', assetClass: 'commodity', hasMapRows: true }],
      ['DXY', { code: 'DXY', assetClass: 'index', hasMapRows: false }],
    ]),
  }),
}));

import { oracleScoreOn, toScoreDate, sameScoreDate } from '@modules/trading/services/oracle-snapshot';

beforeEach(() => {
  findPairScore.mockReset();
  findScorecard.mockReset();
  findAsset.mockReset();
  findAsset.mockResolvedValue({ id: 'asset-id' });
});

describe('toScoreDate / sameScoreDate', () => {
  it('addresses the UTC calendar date', () => {
    expect(toScoreDate(new Date('2026-08-17T23:30:00Z')).toISOString()).toBe('2026-08-17T00:00:00.000Z');
    expect(sameScoreDate(new Date('2026-08-17T01:00:00Z'), new Date('2026-08-17T22:00:00Z'))).toBe(true);
    expect(sameScoreDate(null, null)).toBe(true);
    expect(sameScoreDate(new Date(), null)).toBe(false);
  });
});

describe('oracleScoreOn', () => {
  it('reads the current pair score for the exact entry date (forex)', async () => {
    findPairScore.mockResolvedValue({ totalScore: 4 });
    expect(await oracleScoreOn('EURUSD', new Date('2026-08-17T02:00:00Z'))).toBe(4);
    const where = findPairScore.mock.calls[0][0].where;
    expect(where.isCurrent).toBe(true);
    expect(where.scoreDate.toISOString()).toBe('2026-08-17T00:00:00.000Z');
    expect(findScorecard).not.toHaveBeenCalled();
  });

  it('returns null — never a nearby date — when no row exists for that date', async () => {
    findPairScore.mockResolvedValue(null);
    expect(await oracleScoreOn('EURUSD', new Date('2025-11-01T00:00:00Z'))).toBeNull();
  });

  it('reads the asset scorecard for a non-FX instrument that carries one', async () => {
    findScorecard.mockResolvedValue({ totalScore: -6 });
    expect(await oracleScoreOn('XAUUSD', new Date('2026-06-17T00:00:00Z'))).toBe(-6);
    expect(findPairScore).not.toHaveBeenCalled();
  });

  it('returns null for an unknown symbol or an unscored instrument', async () => {
    expect(await oracleScoreOn('MADEUP', new Date())).toBeNull();
    expect(await oracleScoreOn('DXY', new Date())).toBeNull();
    expect(findScorecard).not.toHaveBeenCalled();
  });
});

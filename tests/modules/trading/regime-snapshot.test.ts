import { describe, it, expect, vi, beforeEach } from 'vitest';

const getRegimeGateAsOf = vi.fn();

vi.mock('@core/db/prisma', () => ({ prisma: {} }));
vi.mock('@modules/edgefinder/api/instrument-registry', () => ({
  getInstrumentRegistry: async () => ({ byCode: new Map() }),
}));
vi.mock('@core/repositories/compass-classifications.repository', () => ({
  compassClassificationsRepository: {
    getRegimeGateAsOf: (...a: unknown[]) => getRegimeGateAsOf(...a),
  },
}));

import { snapshotCompassRegime } from '@modules/trading/services/regime-snapshot';

beforeEach(() => {
  getRegimeGateAsOf.mockReset();
});

describe('snapshotCompassRegime', () => {
  it('reads the live classification in effect on the UTC entry date and stores its final regime', async () => {
    getRegimeGateAsOf.mockResolvedValue({
      classificationDate: new Date('2026-08-14T00:00:00Z'),
      activeRegime: 'Risk-On',
      finalRegime: 'Risk-Off',
    });
    const snap = await snapshotCompassRegime(new Date('2026-08-16T21:30:00Z'));
    const [date, isValidation] = getRegimeGateAsOf.mock.calls[0];
    expect((date as Date).toISOString()).toBe('2026-08-16T00:00:00.000Z');
    expect(isValidation).toBe(false);
    expect(snap).toEqual({
      compassRegimeAtEntry: 'Risk-Off',
      compassRegimeEntryDate: new Date('2026-08-14T00:00:00Z'),
      compassRegimeEntrySource: 'snapshot',
    });
  });

  it('falls back to the active regime on a row written before the Shock Layer (empty final regime)', async () => {
    getRegimeGateAsOf.mockResolvedValue({
      classificationDate: new Date('2026-06-01T00:00:00Z'),
      activeRegime: 'Caution',
      finalRegime: '',
    });
    const snap = await snapshotCompassRegime(new Date('2026-06-01T10:00:00Z'));
    expect(snap.compassRegimeAtEntry).toBe('Caution');
    expect(snap.compassRegimeEntrySource).toBe('snapshot');
  });

  it('stores nothing when no classification exists on or before the entry date', async () => {
    getRegimeGateAsOf.mockResolvedValue(null);
    expect(await snapshotCompassRegime(new Date('2025-11-18T09:00:00Z'))).toEqual({
      compassRegimeAtEntry: null,
      compassRegimeEntryDate: null,
      compassRegimeEntrySource: null,
    });
  });
});

import { describe, it, expect } from 'vitest';
import { pickLatestRelease, ordinalOf } from '@core/scoring/helpers/latest-release';
import type { DataPoint } from '@prisma/client';

/**
 * SYNTHETIC — no live data exercises this path yet (no real Flash/Final pair
 * has been entered for the same observationDate through the admin UI as of
 * this test). This is the one behaviour B3 depends on that has zero live
 * coverage, so it is proven here directly against hand-built fixtures rather
 * than left untested.
 *
 * The scenario: two rows, same indicator, same observationDate, different
 * variants — and the HIGHER-ordinal (Final) row is deliberately given the
 * EARLIER vintageDate, to prove ordinal wins the tie even when entry order
 * would suggest the opposite (see the ordinal-not-vintageDate rationale in
 * latest-release.ts's header comment).
 */

function fakeDataPoint(overrides: Partial<DataPoint>): DataPoint {
  return {
    id: 'synthetic',
    indicatorId: 'synthetic-indicator',
    observationDate: new Date('2026-08-01'),
    variant: null,
    isLegacyVariant: false,
    value: '0' as unknown as DataPoint['value'],
    forecastValue: null,
    previousValue: null,
    vintageDate: new Date('2026-08-01T00:00:00Z'),
    isCurrent: true,
    dataQualityFlag: null,
    source: 'manual',
    sourceMetadata: null,
    notes: null,
    fetchedVia: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    createdBy: null,
    ...overrides,
  } as DataPoint;
}

describe('pickLatestRelease (synthetic Flash/Final tiebreak)', () => {
  it('picks the higher-ordinal (Final) row even when it was entered BEFORE the Flash row', () => {
    const ordinals = new Map([
      ['flash', 1],
      ['final', 2],
    ]);

    const flashEnteredLater = fakeDataPoint({
      id: 'flash-row',
      variant: 'flash',
      observationDate: new Date('2026-08-01'),
      // Entered AFTER final — later vintageDate, but lower ordinal.
      vintageDate: new Date('2026-08-05T12:00:00Z'),
    });

    const finalEnteredEarlier = fakeDataPoint({
      id: 'final-row',
      variant: 'final',
      observationDate: new Date('2026-08-01'),
      // Entered BEFORE flash — earlier vintageDate, but higher ordinal.
      // This is the adversarial case: if vintageDate were the primary
      // tiebreaker, flash-row (entered later) would win. It must not.
      vintageDate: new Date('2026-08-02T09:00:00Z'),
    });

    const winner = pickLatestRelease([flashEnteredLater, finalEnteredEarlier], ordinals);

    expect(winner?.id).toBe('final-row');
    expect(winner?.variant).toBe('final');
  });

  it('order of the input array does not change the outcome', () => {
    const ordinals = new Map([
      ['flash', 1],
      ['final', 2],
    ]);

    const flashEnteredLater = fakeDataPoint({
      id: 'flash-row',
      variant: 'flash',
      observationDate: new Date('2026-08-01'),
      vintageDate: new Date('2026-08-05T12:00:00Z'),
    });
    const finalEnteredEarlier = fakeDataPoint({
      id: 'final-row',
      variant: 'final',
      observationDate: new Date('2026-08-01'),
      vintageDate: new Date('2026-08-02T09:00:00Z'),
    });

    const winnerReversed = pickLatestRelease([finalEnteredEarlier, flashEnteredLater], ordinals);
    expect(winnerReversed?.id).toBe('final-row');
  });

  it('falls back to vintageDate when ordinals tie (two current rows for the same variant — the known NIFTY duplicate-write shape)', () => {
    const ordinals = new Map([['final', 2]]);

    const older = fakeDataPoint({
      id: 'older',
      variant: 'final',
      observationDate: new Date('2026-08-01'),
      vintageDate: new Date('2026-08-01T10:00:00Z'),
    });
    const newer = fakeDataPoint({
      id: 'newer',
      variant: 'final',
      observationDate: new Date('2026-08-01'),
      vintageDate: new Date('2026-08-01T10:00:01Z'),
    });

    expect(pickLatestRelease([older, newer], ordinals)?.id).toBe('newer');
    expect(pickLatestRelease([newer, older], ordinals)?.id).toBe('newer');
  });

  it('an unregistered/null variant never outranks a registered one on the same date', () => {
    const ordinals = new Map([['final', 2]]);

    const legacyNullVariant = fakeDataPoint({
      id: 'legacy',
      variant: null,
      observationDate: new Date('2026-08-01'),
      // Deliberately the LATEST vintageDate of the two, to prove ordinal
      // (-1 for null/unregistered) still loses to a registered variant.
      vintageDate: new Date('2026-08-10T00:00:00Z'),
    });
    const registeredFinal = fakeDataPoint({
      id: 'final-row',
      variant: 'final',
      observationDate: new Date('2026-08-01'),
      vintageDate: new Date('2026-08-02T00:00:00Z'),
    });

    expect(pickLatestRelease([legacyNullVariant, registeredFinal], ordinals)?.id).toBe('final-row');
  });

  it('prefers the later observationDate regardless of variant/ordinal', () => {
    const ordinals = new Map([
      ['flash', 1],
      ['final', 2],
    ]);

    const earlierFinal = fakeDataPoint({
      id: 'earlier-final',
      variant: 'final',
      observationDate: new Date('2026-07-01'),
      vintageDate: new Date('2026-07-05T00:00:00Z'),
    });
    const laterFlash = fakeDataPoint({
      id: 'later-flash',
      variant: 'flash',
      observationDate: new Date('2026-08-01'),
      vintageDate: new Date('2026-08-01T00:00:00Z'),
    });

    expect(pickLatestRelease([earlierFinal, laterFlash], ordinals)?.id).toBe('later-flash');
  });
});

describe('ordinalOf', () => {
  it('returns -1 for a null variant', () => {
    expect(ordinalOf(null, new Map([['final', 2]]))).toBe(-1);
  });

  it('returns -1 for a variant absent from the registry map (unregistered)', () => {
    expect(ordinalOf('flash', new Map())).toBe(-1);
  });

  it('returns the registered ordinal for a known variant', () => {
    expect(ordinalOf('final', new Map([['flash', 1], ['final', 2]]))).toBe(2);
  });
});

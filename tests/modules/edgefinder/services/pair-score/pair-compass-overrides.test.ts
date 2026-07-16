import { describe, it, expect } from 'vitest';
import { computePairCompassOverrides } from '@modules/edgefinder/services/pair-score/pair-compass-overrides';

/** Defaults: regime path Risk-Off, 8A gate permits Override 5, no Trigger B. */
function args(overrides: Partial<Parameters<typeof computePairCompassOverrides>[0]> = {}) {
  return {
    pairCode: 'EURJPY',
    regimePathRiskOff: true,
    override5Active: true,
    shockBActive: false,
    jpySafeHavenBoost: 0,
    ...overrides,
  };
}

describe('computePairCompassOverrides — activation path', () => {
  it('no regime path + no Trigger B → no override', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'EURJPY', regimePathRiskOff: false, override5Active: false }),
    );
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });
});

describe('Override 5 — carry unwind (gated by 8A)', () => {
  it('[case 2] regime path + gate permits + EURJPY → -1 carry unwind fires', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'EURJPY', override5Active: true }));
    expect(r.totalAdjustment).toBe(-1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_5_CARRY_UNWIND');
    expect(r.overridesFired[0].pair).toBe('EURJPY');
  });

  it('[case 1] regime path + gate hawkish (override5Active=false) → SUPPRESSED', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'EURJPY', override5Active: false }));
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('[case 4] Trigger B bypass (override5Active true via bypass, path not Risk-Off) → -1 fires', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'GBPJPY', regimePathRiskOff: false, override5Active: true, shockBActive: true }),
    );
    expect(r.totalAdjustment).toBe(-1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_5_CARRY_UNWIND');
  });

  it('[case 5] Trigger A path + hawkish + no Trigger B → SUPPRESSED (no bypass)', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'EURJPY', regimePathRiskOff: true, override5Active: false, shockBActive: false }),
    );
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('GBPJPY → carry unwind fires', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'GBPJPY' }));
    expect(r.overridesFired[0].pair).toBe('GBPJPY');
  });

  it('USDJPY → no Override 5 (exempt); only safe-haven can apply', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'USDJPY', jpySafeHavenBoost: 0 }));
    expect(r.overridesFired.find((o) => o.code === 'OVERRIDE_5_CARRY_UNWIND')).toBeUndefined();
  });

  it('EURUSD (no JPY) → no override', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'EURUSD' }));
    expect(r.totalAdjustment).toBe(0);
  });
});

describe('Override 3 propagation — jpySafeHavenBoost (already gate-suppressed upstream)', () => {
  it('boost > 0 on a JPY pair → -boost safe-haven adjustment (EURJPY total -2 with carry unwind)', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'EURJPY', override5Active: true, jpySafeHavenBoost: 1 }));
    expect(r.totalAdjustment).toBe(-2); // -1 safe haven + -1 carry unwind
    expect(r.overridesFired.map((o) => o.code).sort()).toEqual([
      'OVERRIDE_3_JPY_SAFE_HAVEN',
      'OVERRIDE_5_CARRY_UNWIND',
    ]);
  });

  it('boost 0 (gate suppressed Override 3 upstream) → no safe-haven adjustment', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'USDJPY', jpySafeHavenBoost: 0 }));
    expect(r.overridesFired.find((o) => o.code === 'OVERRIDE_3_JPY_SAFE_HAVEN')).toBeUndefined();
  });
});

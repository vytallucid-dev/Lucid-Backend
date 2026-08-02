import { describe, it, expect } from 'vitest';
import { computePairCompassOverrides } from '@modules/edgefinder/services/pair-score/pair-compass-overrides';

/**
 * Phase 5: quoteCurrency/isCarryPair are now explicit inputs, derived by the
 * real caller from the pair's own registry definition (base/quote,
 * Asset.metadata.isCarryPair) — not re-derived from pairCode inside the pure
 * function. Tests must supply values matching what the real registry holds
 * for each pairCode, exactly as pair-score.service.ts would pass them.
 *
 * Real registry values (verified against the live DB in Phase 5 A3):
 *   EURJPY/GBPJPY/AUDJPY: quote=JPY, isCarryPair=true
 *   USDJPY:               quote=JPY, isCarryPair=false (exempt from Override 5)
 *   EURUSD/others:        quote!=JPY, isCarryPair=false
 *
 * Defaults: regime path Risk-Off, 8A gate permits Override 5, no Trigger B,
 * EURJPY's real values.
 */
function args(overrides: Partial<Parameters<typeof computePairCompassOverrides>[0]> = {}) {
  return {
    pairCode: 'EURJPY',
    quoteCurrency: 'JPY',
    isCarryPair: true,
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

describe('Override 5 — carry unwind (gated by 8A, derived from isCarryPair)', () => {
  it('[case 2] regime path + gate permits + EURJPY (isCarryPair) → -1 carry unwind fires', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'EURJPY', isCarryPair: true, override5Active: true }));
    expect(r.totalAdjustment).toBe(-1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_5_CARRY_UNWIND');
    expect(r.overridesFired[0].pair).toBe('EURJPY');
  });

  it('[case 1] regime path + gate hawkish (override5Active=false) → SUPPRESSED', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'EURJPY', isCarryPair: true, override5Active: false }));
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('[case 4] Trigger B bypass (override5Active true via bypass, path not Risk-Off) → -1 fires', () => {
    const r = computePairCompassOverrides(
      args({
        pairCode: 'GBPJPY',
        quoteCurrency: 'JPY',
        isCarryPair: true,
        regimePathRiskOff: false,
        override5Active: true,
        shockBActive: true,
      }),
    );
    expect(r.totalAdjustment).toBe(-1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_5_CARRY_UNWIND');
  });

  it('[case 5] Trigger A path + hawkish + no Trigger B → SUPPRESSED (no bypass)', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'EURJPY', isCarryPair: true, regimePathRiskOff: true, override5Active: false, shockBActive: false }),
    );
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('GBPJPY (isCarryPair) → carry unwind fires', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'GBPJPY', quoteCurrency: 'JPY', isCarryPair: true }));
    expect(r.overridesFired[0].pair).toBe('GBPJPY');
  });

  // Phase 5: the fix under test. AUDJPY was excluded by the old hand-maintained
  // set; isCarryPair now derives its eligibility the same way EUR/GBPJPY do.
  it('AUDJPY (isCarryPair) → carry unwind fires — the Phase 5 fix', () => {
    const r = computePairCompassOverrides(args({ pairCode: 'AUDJPY', quoteCurrency: 'JPY', isCarryPair: true }));
    expect(r.totalAdjustment).toBe(-1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_5_CARRY_UNWIND');
    expect(r.overridesFired[0].pair).toBe('AUDJPY');
  });

  it('USDJPY (isCarryPair=false) → no Override 5 (exempt); only safe-haven can apply', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'USDJPY', quoteCurrency: 'JPY', isCarryPair: false, jpySafeHavenBoost: 0 }),
    );
    expect(r.overridesFired.find((o) => o.code === 'OVERRIDE_5_CARRY_UNWIND')).toBeUndefined();
  });

  it('EURUSD (isCarryPair=false, quote!=JPY) → no override', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'EURUSD', quoteCurrency: 'USD', isCarryPair: false }),
    );
    expect(r.totalAdjustment).toBe(0);
  });
});

describe('Override 3 propagation — jpySafeHavenBoost, derived from quoteCurrency', () => {
  it('boost > 0 on a JPY-quote pair → -boost safe-haven adjustment (EURJPY total -2 with carry unwind)', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'EURJPY', quoteCurrency: 'JPY', isCarryPair: true, override5Active: true, jpySafeHavenBoost: 1 }),
    );
    expect(r.totalAdjustment).toBe(-2); // -1 safe haven + -1 carry unwind
    expect(r.overridesFired.map((o) => o.code).sort()).toEqual([
      'OVERRIDE_3_JPY_SAFE_HAVEN',
      'OVERRIDE_5_CARRY_UNWIND',
    ]);
  });

  // Phase 5: AUDJPY previously received the boost fetch (pair-score.service.ts
  // already gated the fetch on pairDef.quote === 'JPY', not a pair-code set)
  // but the OLD JPY_PAIRS set inside this function silently dropped it at
  // application time. Now derived from quoteCurrency, so it applies.
  it('boost > 0 on AUDJPY (quote=JPY, isCarryPair) → -boost safe-haven AND -1 carry unwind, total -2', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'AUDJPY', quoteCurrency: 'JPY', isCarryPair: true, override5Active: true, jpySafeHavenBoost: 1 }),
    );
    expect(r.totalAdjustment).toBe(-2);
    expect(r.overridesFired.map((o) => o.code).sort()).toEqual([
      'OVERRIDE_3_JPY_SAFE_HAVEN',
      'OVERRIDE_5_CARRY_UNWIND',
    ]);
  });

  it('boost 0 (gate suppressed Override 3 upstream) → no safe-haven adjustment', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'USDJPY', quoteCurrency: 'JPY', isCarryPair: false, jpySafeHavenBoost: 0 }),
    );
    expect(r.overridesFired.find((o) => o.code === 'OVERRIDE_3_JPY_SAFE_HAVEN')).toBeUndefined();
  });

  it('boost > 0 but quoteCurrency != JPY → no safe-haven adjustment (defensive; should not occur in practice)', () => {
    const r = computePairCompassOverrides(
      args({ pairCode: 'EURUSD', quoteCurrency: 'USD', isCarryPair: false, jpySafeHavenBoost: 1 }),
    );
    expect(r.overridesFired.find((o) => o.code === 'OVERRIDE_3_JPY_SAFE_HAVEN')).toBeUndefined();
  });
});

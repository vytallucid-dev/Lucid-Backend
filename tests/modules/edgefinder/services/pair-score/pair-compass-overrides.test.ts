import { describe, it, expect } from 'vitest';
import { computePairCompassOverrides } from '@modules/edgefinder/services/pair-score/pair-compass-overrides';

describe('computePairCompassOverrides — regime gating', () => {
  it('Risk-On + EURJPY → no override', () => {
    const r = computePairCompassOverrides({ pairCode: 'EURJPY', regime: 'Risk-On' });
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('Caution + EURJPY → no override', () => {
    const r = computePairCompassOverrides({ pairCode: 'EURJPY', regime: 'Caution' });
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });
});

describe('computePairCompassOverrides — Risk-Off pair gating', () => {
  it('Risk-Off + EURUSD → no override (no JPY)', () => {
    const r = computePairCompassOverrides({ pairCode: 'EURUSD', regime: 'Risk-Off' });
    expect(r.totalAdjustment).toBe(0);
  });

  it('Risk-Off + GBPUSD → no override (no JPY)', () => {
    const r = computePairCompassOverrides({ pairCode: 'GBPUSD', regime: 'Risk-Off' });
    expect(r.totalAdjustment).toBe(0);
  });

  it('Risk-Off + USDJPY → no override (USDJPY exempt from override 5)', () => {
    const r = computePairCompassOverrides({ pairCode: 'USDJPY', regime: 'Risk-Off' });
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('Risk-Off + EURJPY → -1 carry unwind fires', () => {
    const r = computePairCompassOverrides({ pairCode: 'EURJPY', regime: 'Risk-Off' });
    expect(r.totalAdjustment).toBe(-1);
    expect(r.overridesFired).toHaveLength(1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_5_CARRY_UNWIND');
    expect(r.overridesFired[0].adjustment).toBe(-1);
    expect(r.overridesFired[0].pair).toBe('EURJPY');
  });

  it('Risk-Off + GBPJPY → -1 carry unwind fires', () => {
    const r = computePairCompassOverrides({ pairCode: 'GBPJPY', regime: 'Risk-Off' });
    expect(r.totalAdjustment).toBe(-1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_5_CARRY_UNWIND');
    expect(r.overridesFired[0].pair).toBe('GBPJPY');
  });
});

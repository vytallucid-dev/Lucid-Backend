import { describe, it, expect } from 'vitest';
import {
  isRegimePathRiskOff,
  computeRateGateHawkish,
  computeUs02ySma,
  evaluateRateGate,
  evaluateFedConstraintGate,
} from '@modules/edgefinder/services/compass/compass-override-gates';

describe('isRegimePathRiskOff', () => {
  it('true when final Risk-Off via standard machine', () => {
    expect(
      isRegimePathRiskOff({ finalRegime: 'Risk-Off', standardActiveRegime: 'Risk-Off', shockAActive: false }),
    ).toBe(true);
  });
  it('true when final Risk-Off via Trigger A shock (standard machine NOT Risk-Off)', () => {
    expect(
      isRegimePathRiskOff({ finalRegime: 'Risk-Off', standardActiveRegime: 'Caution', shockAActive: true }),
    ).toBe(true);
  });
  it('false when final not Risk-Off', () => {
    expect(
      isRegimePathRiskOff({ finalRegime: 'Caution', standardActiveRegime: 'Caution', shockAActive: false }),
    ).toBe(false);
  });
  it('false when final Risk-Off but neither shock A nor standard Risk-Off (defensive)', () => {
    expect(
      isRegimePathRiskOff({ finalRegime: 'Risk-Off', standardActiveRegime: 'Caution', shockAActive: false }),
    ).toBe(false);
  });
});

describe('computeRateGateHawkish', () => {
  it('hawkish when close > sma (strict)', () => {
    expect(computeRateGateHawkish(4.5, 4.4)).toBe(true);
  });
  it('NOT hawkish when close < sma', () => {
    expect(computeRateGateHawkish(4.3, 4.4)).toBe(false);
  });
  it('[case 3] equality after 6-dp rounding → NOT hawkish', () => {
    // 4.1234564 and 4.1234561 both round to 4.123456 → equal → not hawkish.
    expect(computeRateGateHawkish(4.1234564, 4.1234561)).toBe(false);
  });
  it('null when either input null (uncomputable → caller fails open)', () => {
    expect(computeRateGateHawkish(null, 4.4)).toBeNull();
    expect(computeRateGateHawkish(4.4, null)).toBeNull();
  });
});

describe('computeUs02ySma', () => {
  it('averages the last N observations', () => {
    const series = [1, 2, 3, 4, 5, 6];
    expect(computeUs02ySma(series, 3)).toBeCloseTo((4 + 5 + 6) / 3, 9);
  });
  it('null when fewer than N observations (insufficient history)', () => {
    expect(computeUs02ySma([1, 2], 21)).toBeNull();
  });
});

describe('evaluateRateGate — Addendum 8A (Overrides 3 & 5)', () => {
  const base = { enabled: true, regimePathRiskOff: true, shockBActive: false };

  it('[case 1] hawkish + regime Risk-Off + no Trigger B → SUPPRESSED', () => {
    const r = evaluateRateGate({ ...base, rateGateHawkish: true });
    expect(r.overridesActive).toBe(false);
    expect(r.suppressedByGate).toBe(true);
  });

  it('[case 2] NOT hawkish + regime Risk-Off → APPLY', () => {
    const r = evaluateRateGate({ ...base, rateGateHawkish: false });
    expect(r.overridesActive).toBe(true);
    expect(r.suppressedByGate).toBe(false);
  });

  it('[case 4] Trigger B active + hawkish → APPLY (bypass), not suppressed', () => {
    const r = evaluateRateGate({ ...base, rateGateHawkish: true, shockBActive: true });
    expect(r.overridesActive).toBe(true);
    expect(r.suppressedByGate).toBe(false);
  });

  it('[case 4b] Trigger B active while regime path is NOT Risk-Off → still APPLY (bypass)', () => {
    const r = evaluateRateGate({
      enabled: true,
      regimePathRiskOff: false,
      rateGateHawkish: true,
      shockBActive: true,
    });
    expect(r.overridesActive).toBe(true);
    expect(r.suppressedByGate).toBe(false);
  });

  it('[case 6] stale/uncomputable hawkish (null) → FAILS OPEN (applies) + staleFailedOpen flag', () => {
    const r = evaluateRateGate({ ...base, rateGateHawkish: null });
    expect(r.overridesActive).toBe(true);
    expect(r.suppressedByGate).toBe(false);
    expect(r.staleFailedOpen).toBe(true);
    expect(r.hawkishResolved).toBe(false);
  });

  it('[case 7] rate_gate_enabled=false → full pre-gate behaviour (applies on regime path, never suppressed even if hawkish)', () => {
    const r = evaluateRateGate({
      enabled: false,
      regimePathRiskOff: true,
      rateGateHawkish: true,
      shockBActive: false,
    });
    expect(r.overridesActive).toBe(true);
    expect(r.suppressedByGate).toBe(false);
  });

  it('no regime path and no Trigger B → nothing active, nothing suppressed', () => {
    const r = evaluateRateGate({
      enabled: true,
      regimePathRiskOff: false,
      rateGateHawkish: true,
      shockBActive: false,
    });
    expect(r.overridesActive).toBe(false);
    expect(r.suppressedByGate).toBe(false);
  });
});

describe('evaluateFedConstraintGate — Addendum 8B (Override 2)', () => {
  it('[case 9] CONSTRAINED + regime Risk-Off → Override 2 applies', () => {
    const r = evaluateFedConstraintGate({ regimePathRiskOff: true, fedConstraint: 'CONSTRAINED' });
    expect(r.overrideActive).toBe(true);
    expect(r.suppressedByConstraint).toBe(false);
  });

  it('[case 10] FREE + regime Risk-Off → Override 2 suppressed', () => {
    const r = evaluateFedConstraintGate({ regimePathRiskOff: true, fedConstraint: 'FREE' });
    expect(r.overrideActive).toBe(false);
    expect(r.suppressedByConstraint).toBe(true);
  });

  it('[case 11] missing/unresolvable → defaults FREE → suppressed (caller passes FREE)', () => {
    const r = evaluateFedConstraintGate({ regimePathRiskOff: true, fedConstraint: 'FREE' });
    expect(r.overrideActive).toBe(false);
    expect(r.suppressedByConstraint).toBe(true);
  });

  it('[case 12] Trigger A active + FREE → STILL suppressed (no Override 2 bypass exists)', () => {
    // Trigger A routes through regimePathRiskOff=true, but there is no shock
    // parameter here — the fed gate has no bypass, so FREE suppresses regardless.
    const r = evaluateFedConstraintGate({ regimePathRiskOff: true, fedConstraint: 'FREE' });
    expect(r.overrideActive).toBe(false);
    expect(r.suppressedByConstraint).toBe(true);
  });

  it('no regime path → nothing active, nothing suppressed (even if CONSTRAINED)', () => {
    const r = evaluateFedConstraintGate({ regimePathRiskOff: false, fedConstraint: 'CONSTRAINED' });
    expect(r.overrideActive).toBe(false);
    expect(r.suppressedByConstraint).toBe(false);
  });
});

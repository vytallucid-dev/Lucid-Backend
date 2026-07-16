import { describe, it, expect } from 'vitest';
import {
  computeCompassOverridesForAsset,
  type IndicatorScoreInput,
  type OverrideGateContext,
} from '@modules/edgefinder/services/scorecard/compass-overrides';

function ind(
  code: string,
  baseScore: number,
  category: IndicatorScoreInput['category'] = 'Other',
): IndicatorScoreInput {
  return { indicatorCode: code, baseScore, category };
}

/**
 * Gate context helper. Defaults model "regime path Risk-Off, all gates
 * permit" (the pre-Phase-6 behaviour) so the existing override math is
 * exercised unchanged; individual tests override specific gate flags.
 */
function gate(overrides: Partial<OverrideGateContext> = {}): OverrideGateContext {
  return {
    regimePathRiskOff: true,
    override2Active: true,
    override3And5Active: true,
    shockBActive: false,
    ...overrides,
  };
}

const NO_PATH = gate({
  regimePathRiskOff: false,
  override2Active: false,
  override3And5Active: false,
});

describe('computeCompassOverridesForAsset — regime path gating', () => {
  it('no regime path (Risk-On/Caution) → no overrides regardless of asset', () => {
    const r = computeCompassOverridesForAsset('USD', NO_PATH, [ind('US_NFP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('no regime path + JPY → no overrides', () => {
    const r = computeCompassOverridesForAsset('JPY', NO_PATH, []);
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });
});

describe('[case 13] Override 4 — USD weak jobs (UNGATED, unchanged by any gate)', () => {
  it('USD + regime path + NFP -1 → +1 adjustment, override 4 fires', () => {
    const r = computeCompassOverridesForAsset('USD', gate(), [ind('US_NFP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_4_USD_WEAK_JOBS');
    expect(r.overridesFired[0].indicatorsAffected).toEqual(['US_NFP']);
  });

  it('Override 4 fires even when both gates are SUPPRESSING (it is ungated)', () => {
    const r = computeCompassOverridesForAsset(
      'USD',
      gate({ override2Active: false, override3And5Active: false }),
      [ind('US_NFP', -1, 'Jobs')],
    );
    expect(r.totalAdjustment).toBe(1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_4_USD_WEAK_JOBS');
  });

  it('USD + NFP +1 → no adjustment (beats not flipped)', () => {
    const r = computeCompassOverridesForAsset('USD', gate(), [ind('US_NFP', 1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
  });

  it('USD + NFP -1 AND Unemp -1 → +2 adjustment', () => {
    const r = computeCompassOverridesForAsset('USD', gate(), [
      ind('US_NFP', -1, 'Jobs'),
      ind('US_UNEMP', -1, 'Jobs'),
    ]);
    expect(r.totalAdjustment).toBe(2);
  });
});

describe('Override 2 — Gold inflation hedge (gated by 8B fed constraint)', () => {
  it('[case 9] XAUUSD + regime path + fed CONSTRAINED (override2Active) + CPI -1 → +2, fires', () => {
    const r = computeCompassOverridesForAsset('XAUUSD', gate({ override2Active: true }), [
      ind('US_CPI_YOY', -1, 'Inflation'),
    ]);
    expect(r.totalAdjustment).toBe(2);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_2_GOLD_INFLATION_HEDGE');
  });

  it('[case 10] XAUUSD + regime path + fed FREE (override2Active=false) → SUPPRESSED, adjustment 0', () => {
    const r = computeCompassOverridesForAsset('XAUUSD', gate({ override2Active: false }), [
      ind('US_CPI_YOY', -1, 'Inflation'),
    ]);
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('[case 12] XAUUSD + Trigger A path + fed FREE → STILL SUPPRESSED (no bypass for Override 2)', () => {
    // Trigger A sets regimePathRiskOff true, but override2Active is false
    // under FREE — and there is no shock bypass for the gold gate.
    const r = computeCompassOverridesForAsset(
      'XAUUSD',
      gate({ regimePathRiskOff: true, override2Active: false, shockBActive: false }),
      [ind('US_CPI_YOY', -1, 'Inflation')],
    );
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('XAUUSD + override2Active + CPI +1 → -2 (deflation, gold unwinds)', () => {
    const r = computeCompassOverridesForAsset('XAUUSD', gate(), [ind('US_CPI_YOY', 1, 'Inflation')]);
    expect(r.totalAdjustment).toBe(-2);
  });

  it('XAUUSD + override2Active + CPI -1 AND PPI -1 → +4', () => {
    const r = computeCompassOverridesForAsset('XAUUSD', gate(), [
      ind('US_CPI_YOY', -1, 'Inflation'),
      ind('US_PPI_MOM', -1, 'Inflation'),
    ]);
    expect(r.totalAdjustment).toBe(4);
  });
});

describe('Override 3 — JPY safe haven (gated by 8A rate gate, +1 cap)', () => {
  it('[case 2] JPY + regime path + gate NOT hawkish (override3And5Active) → +1, fires', () => {
    const r = computeCompassOverridesForAsset('JPY', gate({ override3And5Active: true }), []);
    expect(r.totalAdjustment).toBe(1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_3_JPY_SAFE_HAVEN');
  });

  it('[case 1] JPY + regime path + gate hawkish (override3And5Active=false) → SUPPRESSED, adjustment 0', () => {
    const r = computeCompassOverridesForAsset('JPY', gate({ override3And5Active: false }), []);
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('[case 4] JPY + Trigger B bypass (override3And5Active=true via bypass) → +1, fires despite hawkish', () => {
    // The bypass is folded into override3And5Active by the caller; here it is true.
    const r = computeCompassOverridesForAsset(
      'JPY',
      gate({ override3And5Active: true, shockBActive: true }),
      [],
    );
    expect(r.totalAdjustment).toBe(1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_3_JPY_SAFE_HAVEN');
  });

  it('[case 5] JPY + Trigger A path + gate hawkish + NO Trigger B → SUPPRESSED (Trigger A does not bypass)', () => {
    // Trigger A → regimePathRiskOff true, but override3And5Active is false
    // (hawkish, no Trigger B) → suppressed. This is the load-bearing asymmetry.
    const r = computeCompassOverridesForAsset(
      'JPY',
      gate({ regimePathRiskOff: true, override3And5Active: false, shockBActive: false }),
      [],
    );
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('[case 8] Override 3 cap stays +1 max when it applies', () => {
    const r = computeCompassOverridesForAsset('JPY', gate(), []);
    expect(r.totalAdjustment).toBe(1);
    expect(r.overridesFired[0].adjustment).toBe(1);
  });
});

describe('[case 13] Override 1 — SPY/NAS bad-news-good-news (UNGATED)', () => {
  it('SPY + regime path + NFP -1 → +2, override 1 fires', () => {
    const r = computeCompassOverridesForAsset('SPY', gate(), [ind('US_NFP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(2);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_1_BAD_NEWS_GOOD_NEWS');
  });

  it('Override 1 fires even when both gates suppress (ungated)', () => {
    const r = computeCompassOverridesForAsset(
      'SPY',
      gate({ override2Active: false, override3And5Active: false }),
      [ind('US_NFP', -1, 'Jobs')],
    );
    expect(r.totalAdjustment).toBe(2);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_1_BAD_NEWS_GOOD_NEWS');
  });

  it('NAS100 + NFP -1 + JOLTS -1 → +4', () => {
    const r = computeCompassOverridesForAsset('NAS100', gate(), [
      ind('US_NFP', -1, 'Jobs'),
      ind('US_JOLTS', -1, 'Jobs'),
    ]);
    expect(r.totalAdjustment).toBe(4);
  });
});

describe('Other assets', () => {
  it('EUR + regime path → no override', () => {
    const r = computeCompassOverridesForAsset('EUR', gate(), [ind('EU_UNEMP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
  });

  it('Unknown asset + regime path → no override', () => {
    const r = computeCompassOverridesForAsset('UNKNOWN', gate(), [ind('US_NFP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
  });
});

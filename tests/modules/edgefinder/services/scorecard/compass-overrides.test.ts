import { describe, it, expect } from 'vitest';
import {
  computeCompassOverridesForAsset,
  type IndicatorScoreInput,
} from '@modules/edgefinder/services/scorecard/compass-overrides';

function ind(
  code: string,
  baseScore: number,
  category: IndicatorScoreInput['category'] = 'Other',
): IndicatorScoreInput {
  return { indicatorCode: code, baseScore, category };
}

describe('computeCompassOverridesForAsset — regime gating', () => {
  it('Risk-On regime → no overrides regardless of asset', () => {
    const r = computeCompassOverridesForAsset('USD', 'Risk-On', [ind('US_NFP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('Caution regime → no overrides regardless of asset', () => {
    const r = computeCompassOverridesForAsset('JPY', 'Caution', [ind('JP_NFP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });
});

describe('Override 4 — USD weak jobs neutralization', () => {
  it('USD + Risk-Off + NFP score -1 → +1 adjustment, override 4 fires', () => {
    const r = computeCompassOverridesForAsset('USD', 'Risk-Off', [ind('US_NFP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(1);
    expect(r.overridesFired).toHaveLength(1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_4_USD_WEAK_JOBS');
    expect(r.overridesFired[0].indicatorsAffected).toEqual(['US_NFP']);
  });

  it('USD + Risk-Off + NFP score +1 → no adjustment (beats are not flipped)', () => {
    const r = computeCompassOverridesForAsset('USD', 'Risk-Off', [ind('US_NFP', 1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('USD + Risk-Off + NFP -1 AND Unemp -1 → +2 adjustment', () => {
    const r = computeCompassOverridesForAsset('USD', 'Risk-Off', [
      ind('US_NFP', -1, 'Jobs'),
      ind('US_UNEMP', -1, 'Jobs'),
    ]);
    expect(r.totalAdjustment).toBe(2);
    expect(r.overridesFired[0].indicatorsAffected.sort()).toEqual(['US_NFP', 'US_UNEMP']);
  });

  it('USD + Risk-Off + CPI -1 → no adjustment (inflation not affected by override 4)', () => {
    const r = computeCompassOverridesForAsset('USD', 'Risk-Off', [
      ind('US_CPI_YOY', -1, 'Inflation'),
    ]);
    expect(r.totalAdjustment).toBe(0);
  });
});

describe('Override 2 — Gold inflation hedge', () => {
  it('XAUUSD + Risk-Off + CPI -1 → +2 adjustment, override 2 fires', () => {
    const r = computeCompassOverridesForAsset('XAUUSD', 'Risk-Off', [
      ind('US_CPI_YOY', -1, 'Inflation'),
    ]);
    expect(r.totalAdjustment).toBe(2);
    expect(r.overridesFired).toHaveLength(1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_2_GOLD_INFLATION_HEDGE');
  });

  it('XAUUSD + Risk-Off + CPI +1 → no adjustment', () => {
    const r = computeCompassOverridesForAsset('XAUUSD', 'Risk-Off', [
      ind('US_CPI_YOY', 1, 'Inflation'),
    ]);
    expect(r.totalAdjustment).toBe(0);
  });

  it('XAUUSD + Risk-Off + GDP -1 → no adjustment (growth not flipped by override 2)', () => {
    const r = computeCompassOverridesForAsset('XAUUSD', 'Risk-Off', [
      ind('US_GDP_QOQ', -1, 'Growth'),
    ]);
    expect(r.totalAdjustment).toBe(0);
  });

  it('XAUUSD + Risk-Off + CPI -1 AND PPI -1 → +4 adjustment', () => {
    const r = computeCompassOverridesForAsset('XAUUSD', 'Risk-Off', [
      ind('US_CPI_YOY', -1, 'Inflation'),
      ind('US_PPI_MOM', -1, 'Inflation'),
    ]);
    expect(r.totalAdjustment).toBe(4);
    expect(r.overridesFired[0].indicatorsAffected.sort()).toEqual(['US_CPI_YOY', 'US_PPI_MOM']);
  });

  it('XAUUSD + Risk-Off + PCE -1 → +2 adjustment', () => {
    const r = computeCompassOverridesForAsset('XAUUSD', 'Risk-Off', [
      ind('US_PCE_YOY', -1, 'Inflation'),
    ]);
    expect(r.totalAdjustment).toBe(2);
  });
});

describe('Override 3 — JPY safe-haven boost', () => {
  it('JPY + Risk-Off → +1 adjustment regardless of indicator state', () => {
    const r = computeCompassOverridesForAsset('JPY', 'Risk-Off', []);
    expect(r.totalAdjustment).toBe(1);
    expect(r.overridesFired).toHaveLength(1);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_3_JPY_SAFE_HAVEN');
    expect(r.overridesFired[0].indicatorsAffected).toEqual([]);
  });

  it('JPY + Risk-On → no adjustment', () => {
    const r = computeCompassOverridesForAsset('JPY', 'Risk-On', []);
    expect(r.totalAdjustment).toBe(0);
  });
});

describe('Override 1 — SPY/NAS bad-news-good-news (dormant)', () => {
  it('SPY + Risk-Off + NFP -1 → +2 adjustment, override 1 fires', () => {
    const r = computeCompassOverridesForAsset('SPY', 'Risk-Off', [ind('US_NFP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(2);
    expect(r.overridesFired[0].code).toBe('OVERRIDE_1_BAD_NEWS_GOOD_NEWS');
  });

  it('NAS100 + Risk-Off + NFP -1 + JOLTS -1 → +4 adjustment', () => {
    const r = computeCompassOverridesForAsset('NAS100', 'Risk-Off', [
      ind('US_NFP', -1, 'Jobs'),
      ind('US_JOLTS', -1, 'Jobs'),
    ]);
    expect(r.totalAdjustment).toBe(4);
  });
});

describe('Other assets', () => {
  it('EUR + Risk-Off → no adjustment (no override fires for EUR)', () => {
    const r = computeCompassOverridesForAsset('EUR', 'Risk-Off', [ind('EU_UNEMP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
    expect(r.overridesFired).toHaveLength(0);
  });

  it('GBP + Risk-Off → no adjustment', () => {
    const r = computeCompassOverridesForAsset('GBP', 'Risk-Off', [ind('UK_UNEMP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
  });

  it('Unknown asset + Risk-Off → no adjustment', () => {
    const r = computeCompassOverridesForAsset('UNKNOWN', 'Risk-Off', [ind('US_NFP', -1, 'Jobs')]);
    expect(r.totalAdjustment).toBe(0);
  });
});

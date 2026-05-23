import type { Regime } from '@modules/edgefinder/services/scorecard/compass-overrides';

export interface PairOverrideEntry {
  code: string;
  adjustment: number;
  pair: string;
}

export interface PairOverrideAdjustment {
  totalAdjustment: number;
  overridesFired: PairOverrideEntry[];
}

/**
 * Compute Compass overrides for pair scoring (Spec v1 §5).
 *
 * Only Override 5 (Carry Unwind) applies at pair level:
 *   - active_regime = 'Risk-Off'
 *   - pair is EURJPY or GBPJPY
 *   - adjustment: -1 (makes the pair more bearish, reflecting carry unwind)
 *
 * USDJPY does NOT receive Override 5. JPY safe-haven behavior in Risk-Off is
 * captured at the asset-scorecard level (Override 3); pair scoring is
 * independent of asset scorecard totals per the Phase 5 spec.
 */
export function computePairCompassOverrides(input: {
  pairCode: string;
  regime: Regime;
}): PairOverrideAdjustment {
  if (input.regime !== 'Risk-Off') {
    return { totalAdjustment: 0, overridesFired: [] };
  }
  if (input.pairCode === 'EURJPY' || input.pairCode === 'GBPJPY') {
    return {
      totalAdjustment: -1,
      overridesFired: [
        { code: 'OVERRIDE_5_CARRY_UNWIND', adjustment: -1, pair: input.pairCode },
      ],
    };
  }
  return { totalAdjustment: 0, overridesFired: [] };
}

import { CotLabel } from './cot-label.helpers';

/**
 * Asset-level COT score combination.
 * Returns score in range [-2, +2] from Net Positioning + Change % labels.
 */
export function combineCotLabelsForAsset(
  netLabel: CotLabel,
  changeLabel: CotLabel,
): number {
  const matrix: Record<CotLabel, Record<CotLabel, number>> = {
    Bullish: { Bullish: 2, Neutral: 1, Bearish: 0 },
    Neutral: { Bullish: 1, Neutral: 0, Bearish: -1 },
    Bearish: { Bullish: 0, Neutral: -1, Bearish: -2 },
  };
  return matrix[netLabel][changeLabel];
}

/**
 * Pair-level COT score combination.
 * Head-to-head A vs B using Change % only. Net Positioning is NOT used in pair
 * scoring. Returns score in range [-2, +2].
 *
 * NOTE: Not consumed by any handler yet. Phase 5 pair-scoring assembly will
 * call this directly when wiring up per-pair COT rows.
 */
export function combineCotLabelsForPair(
  aChangeLabel: CotLabel,
  bChangeLabel: CotLabel,
): number {
  const matrix: Record<CotLabel, Record<CotLabel, number>> = {
    Bullish: { Bullish: 0, Neutral: 1, Bearish: 2 },
    Neutral: { Bullish: -1, Neutral: 0, Bearish: 1 },
    Bearish: { Bullish: -2, Neutral: -1, Bearish: 0 },
  };
  return matrix[aChangeLabel][bChangeLabel];
}

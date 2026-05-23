/**
 * Pure label classification helpers for COT (Commitment of Traders) data.
 * Boundaries are INCLUSIVE on the Neutral side (e.g., 55.0 is Neutral, not Bullish).
 */

export type CotLabel = 'Bullish' | 'Neutral' | 'Bearish';

/**
 * Classify Net Positioning based on long% threshold bands.
 *
 *   long_pct > 55         → Bullish
 *   long_pct < 45         → Bearish
 *   45 ≤ long_pct ≤ 55    → Neutral (inclusive)
 */
export function classifyNetPositioning(longPct: number): CotLabel {
  if (longPct > 55) return 'Bullish';
  if (longPct < 45) return 'Bearish';
  return 'Neutral';
}

/**
 * Classify Change % based on weekly change threshold bands.
 *
 *   change_pct > 0.5         → Bullish
 *   change_pct < -0.5        → Bearish
 *   -0.5 ≤ change_pct ≤ 0.5  → Neutral (inclusive)
 */
export function classifyChangePercent(changePct: number): CotLabel {
  if (changePct > 0.5) return 'Bullish';
  if (changePct < -0.5) return 'Bearish';
  return 'Neutral';
}

import type { Trajectory } from './compass-calculations';

export type ColorBand = 'GREEN' | 'YELLOW' | 'RED';

/**
 * VIX 5-day average:
 *   < 18  → GREEN
 *   > 25  → RED
 *   else  → YELLOW
 */
export function evaluateVix(fiveDayAvg: number): ColorBand {
  if (fiveDayAvg < 18) return 'GREEN';
  if (fiveDayAvg > 25) return 'RED';
  return 'YELLOW';
}

/**
 * HY OAS (units = percent, e.g. 4.50 means 450bp):
 *   > 7.00 (>700bp)                                    → RED
 *   < 4.50 (<450bp) AND 30-day change < 0 (tightening) → GREEN
 *   otherwise                                          → YELLOW
 *
 * NOTE: FRED's BAMLH0A0HYM2 series reports OAS as a percent, not basis
 * points. The Spec text was written in basis points; we convert by using
 * 4.50 / 7.00 thresholds here. `thirtyDayChange` is in the same percent
 * units (so e.g. -0.10 = tightened by 10bp over 30 days).
 */
export function evaluateHyOas(
  level: number,
  thirtyDayChange: number | null,
): ColorBand {
  if (level > 7.0) return 'RED';
  if (level < 4.5 && thirtyDayChange !== null && thirtyDayChange < 0) return 'GREEN';
  return 'YELLOW';
}

/**
 * 2s10s curve (T10Y2Y, in percentage points):
 *   level > 0  AND 30d change > 0     → GREEN (steepening, normal)
 *   level < 0  AND 30d change > 0.1   → RED   (re-steepening from inversion)
 *   otherwise                         → YELLOW
 *
 * Null 30-day change defaults to YELLOW (insufficient history).
 */
export function evaluate2s10s(
  level: number,
  thirtyDayChange: number | null,
): ColorBand {
  if (thirtyDayChange === null) return 'YELLOW';
  if (level > 0 && thirtyDayChange > 0) return 'GREEN';
  if (level < 0 && thirtyDayChange > 0.1) return 'RED';
  return 'YELLOW';
}

/**
 * DXY trend:
 *   |5-day pct change| > 3  → RED   (sharp break)
 *   |distance| > 2%         → GREEN (clear directional move)
 *   otherwise               → YELLOW (range-bound)
 */
export function evaluateDxyTrend(
  pctDistanceFrom50dSMA: number,
  fiveDayPctChange: number,
): ColorBand {
  if (Math.abs(fiveDayPctChange) > 3) return 'RED';
  if (Math.abs(pctDistanceFrom50dSMA) > 2) return 'GREEN';
  return 'YELLOW';
}

/**
 * Gold/DXY 60-day rolling Pearson correlation:
 *   < -0.5   → GREEN (normal inverse)
 *   >  0     → RED   (broken correlation)
 *   else     → YELLOW
 */
export function evaluateGoldDxyCorrelation(correlation: number): ColorBand {
  if (correlation < -0.5) return 'GREEN';
  if (correlation > 0) return 'RED';
  return 'YELLOW';
}

/**
 * CPI trajectory sub-check (last 3 YoY prints):
 *   rising  → RED
 *   falling → GREEN
 *   mixed   → YELLOW
 */
export function evaluateCpiTrajectory(trajectory: Trajectory): ColorBand {
  if (trajectory === 'rising') return 'RED';
  if (trajectory === 'falling') return 'GREEN';
  return 'YELLOW';
}

/**
 * GDP level sub-check (last 2 QoQ values, percent):
 *   both > 1.5 → GREEN
 *   any  < 0   → RED
 *   else       → YELLOW
 */
export function evaluateGdpLevel(qoqValues: number[]): ColorBand {
  if (qoqValues.length < 2) return 'YELLOW';
  const last2 = qoqValues.slice(-2);
  if (last2.every((v) => v > 1.5)) return 'GREEN';
  if (last2.some((v) => v < 0)) return 'RED';
  return 'YELLOW';
}

/**
 * Jobs sub-check:
 *   Sahm-rule triggered                              → RED
 *   avg of last 3 NFP changes > 100 (thousand jobs)  → GREEN
 *   avg < 50                                          → RED
 *   else                                              → YELLOW
 */
export function evaluateJobs(
  sahmTriggered: boolean,
  recentNfpChanges: number[],
): ColorBand {
  if (sahmTriggered) return 'RED';
  if (recentNfpChanges.length === 0) return 'YELLOW';
  const avg =
    recentNfpChanges.reduce((s, v) => s + v, 0) / recentNfpChanges.length;
  if (avg > 100) return 'GREEN';
  if (avg < 50) return 'RED';
  return 'YELLOW';
}

/**
 * US Data Stack aggregation: majority of 3 sub-bands.
 *   ≥2 RED   → RED
 *   ≥2 GREEN → GREEN
 *   else     → YELLOW
 */
export function aggregateUsDataStack(
  cpiTrajectory: ColorBand,
  gdpLevel: ColorBand,
  jobs: ColorBand,
): ColorBand {
  const bands: ColorBand[] = [cpiTrajectory, gdpLevel, jobs];
  const redCount = bands.filter((b) => b === 'RED').length;
  const greenCount = bands.filter((b) => b === 'GREEN').length;
  if (redCount >= 2) return 'RED';
  if (greenCount >= 2) return 'GREEN';
  return 'YELLOW';
}

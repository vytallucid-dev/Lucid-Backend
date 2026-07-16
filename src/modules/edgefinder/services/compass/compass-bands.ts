import type { Trajectory } from './compass-calculations';
import type { CompassConfigDefinition } from './compass-config.types';

export type ColorBand = 'GREEN' | 'YELLOW' | 'RED';

/**
 * VIX 5-day average:
 *   < config.vix.green_below  → GREEN
 *   > config.vix.red_above    → RED
 *   else                      → YELLOW
 */
export function evaluateVix(
  fiveDayAvg: number,
  config: CompassConfigDefinition,
): ColorBand {
  if (fiveDayAvg < config.vix.green_below) return 'GREEN';
  if (fiveDayAvg > config.vix.red_above) return 'RED';
  return 'YELLOW';
}

/**
 * HY OAS velocity + level (units = percent, e.g. 0.75 means 75bp; FRED's
 * BAMLH0A0HYM2 reports OAS as a percent, not basis points — do NOT convert):
 *   delta10 > config.hyOas.delta10_red    OR level > config.hyOas.level_red    → RED
 *   delta10 > config.hyOas.delta10_yellow OR level > config.hyOas.level_yellow → YELLOW
 *   otherwise                                                                  → GREEN
 */
export function evaluateHyOas(
  level: number,
  delta10: number | null,
  config: CompassConfigDefinition,
): ColorBand {
  const d = delta10 ?? -Infinity;
  if (d > config.hyOas.delta10_red || level > config.hyOas.level_red) return 'RED';
  if (d > config.hyOas.delta10_yellow || level > config.hyOas.level_yellow) return 'YELLOW';
  return 'GREEN';
}

/**
 * 2s10s curve (T10Y2Y, in percentage points) — v2 inversion-episode logic.
 * First match wins:
 *   1. insideRedWindow AND jobsSubCheckBand != GREEN  → RED
 *   2. t10y2y >= 0 AND delta30 >= config.yieldCurve.curve_delta30_floor → GREEN
 *   3. otherwise                                       → YELLOW
 *
 * `insideRedWindow` is computed by the caller from the episode state machine
 * (compass-curve-state-machine.ts) — this function is pure and does no date
 * scanning itself. Null delta30 (insufficient history) falls through to rule
 * 3 (YELLOW) since it can never satisfy rule 2's `>= floor` inclusively.
 */
export function evaluate2s10s(
  t10y2y: number,
  delta30: number | null,
  insideRedWindow: boolean,
  jobsSubCheckBand: ColorBand,
  config: CompassConfigDefinition,
): ColorBand {
  if (insideRedWindow && jobsSubCheckBand !== 'GREEN') return 'RED';
  if (t10y2y >= 0 && delta30 !== null && delta30 >= config.yieldCurve.curve_delta30_floor) return 'GREEN';
  return 'YELLOW';
}

/**
 * DXY trend (dev = |distance from 50d SMA|, move5 = |5-obs pct change|, both
 * fractions e.g. 0.03 = 3%):
 *   move5 > config.dxyTrend.move5_red                                        → RED    (sharp break, either direction)
 *   dev <= config.dxyTrend.dev_green AND move5 <= config.dxyTrend.move5_green → GREEN  (calm dollar)
 *   otherwise                                                                 → YELLOW
 */
export function evaluateDxyTrend(
  dev: number,
  move5: number,
  config: CompassConfigDefinition,
): ColorBand {
  if (move5 > config.dxyTrend.move5_red) return 'RED';
  if (dev <= config.dxyTrend.dev_green && move5 <= config.dxyTrend.move5_green) return 'GREEN';
  return 'YELLOW';
}

/**
 * VIX Term Structure (ts_ratio = VIX close / VIX3M close, same-day):
 *   ts_ratio > config.vixTermStructure.ts_red_threshold      → RED    (backwardation)
 *   ts_ratio >= config.vixTermStructure.ts_yellow_threshold  → YELLOW
 *   otherwise                                                → GREEN  (normal contango)
 */
export function evaluateVixTermStructure(
  tsRatio: number,
  config: CompassConfigDefinition,
): ColorBand {
  if (tsRatio > config.vixTermStructure.ts_red_threshold) return 'RED';
  if (tsRatio >= config.vixTermStructure.ts_yellow_threshold) return 'YELLOW';
  return 'GREEN';
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
 *   both > config.gdpLevel.green_above → GREEN
 *   any  < 0                            → RED
 *   else                                 → YELLOW
 */
export function evaluateGdpLevel(
  qoqValues: number[],
  config: CompassConfigDefinition,
): ColorBand {
  if (qoqValues.length < 2) return 'YELLOW';
  const last2 = qoqValues.slice(-2);
  if (last2.every((v) => v > config.gdpLevel.green_above)) return 'GREEN';
  if (last2.some((v) => v < 0)) return 'RED';
  return 'YELLOW';
}

/**
 * Jobs sub-check:
 *   Sahm-rule triggered                                                 → RED
 *   avg of last 3 NFP changes > config.jobs.green_avg_above (thousand)  → GREEN
 *   avg < config.jobs.red_avg_below                                     → RED
 *   else                                                                 → YELLOW
 */
export function evaluateJobs(
  sahmTriggered: boolean,
  recentNfpChanges: number[],
  config: CompassConfigDefinition,
): ColorBand {
  if (sahmTriggered) return 'RED';
  if (recentNfpChanges.length === 0) return 'YELLOW';
  const avg =
    recentNfpChanges.reduce((s, v) => s + v, 0) / recentNfpChanges.length;
  if (avg > config.jobs.green_avg_above) return 'GREEN';
  if (avg < config.jobs.red_avg_below) return 'RED';
  return 'YELLOW';
}

/**
 * US Data Stack aggregation: majority of 3 sub-bands.
 *   ≥config.usDataStack.red_majority RED     → RED
 *   ≥config.usDataStack.green_majority GREEN → GREEN
 *   else                                      → YELLOW
 */
export function aggregateUsDataStack(
  cpiTrajectory: ColorBand,
  gdpLevel: ColorBand,
  jobs: ColorBand,
  config: CompassConfigDefinition,
): ColorBand {
  const bands: ColorBand[] = [cpiTrajectory, gdpLevel, jobs];
  const redCount = bands.filter((b) => b === 'RED').length;
  const greenCount = bands.filter((b) => b === 'GREEN').length;
  if (redCount >= config.usDataStack.red_majority) return 'RED';
  if (greenCount >= config.usDataStack.green_majority) return 'GREEN';
  return 'YELLOW';
}

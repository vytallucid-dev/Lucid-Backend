/**
 * Pure calculation helpers for the 6 Lucid Compass inputs.
 * Tests live in tests/modules/edgefinder/services/compass/compass-calculations.test.ts.
 */

export function compute5DayAverage(closes: number[]): number | null {
  if (closes.length < 5) return null;
  const last5 = closes.slice(-5);
  return last5.reduce((sum, v) => sum + v, 0) / 5;
}

export function compute50DaySMA(closes: number[]): number | null {
  if (closes.length < 50) return null;
  const last50 = closes.slice(-50);
  return last50.reduce((sum, v) => sum + v, 0) / 50;
}

export function computePctDistance(current: number, sma: number): number {
  if (sma === 0) return 0;
  return ((current - sma) / sma) * 100;
}

export function compute5DayPctChange(closes: number[]): number | null {
  if (closes.length < 6) return null;
  const last = closes[closes.length - 1];
  const fiveDaysAgo = closes[closes.length - 6];
  if (fiveDaysAgo === 0) return 0;
  return ((last - fiveDaysAgo) / fiveDaysAgo) * 100;
}

export function compute30DayChange(values: number[]): number | null {
  if (values.length < 31) return null;
  return values[values.length - 1] - values[values.length - 31];
}

export function computePearsonCorrelation(
  x: number[],
  y: number[],
): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  const n = x.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  const denom = Math.sqrt(varX * varY);
  if (denom === 0) return null;
  return cov / denom;
}

export function computeYoYSequence(monthlyLevels: number[]): (number | null)[] {
  return monthlyLevels.map((level, i) => {
    if (i < 12) return null;
    const yearAgo = monthlyLevels[i - 12];
    if (yearAgo === 0) return null;
    return ((level - yearAgo) / yearAgo) * 100;
  });
}

export type Trajectory = 'rising' | 'falling' | 'mixed';

export function detectTrajectory(values: number[]): Trajectory {
  if (values.length < 2) return 'mixed';
  let allRising = true;
  let allFalling = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) allRising = false;
    if (values[i] >= values[i - 1]) allFalling = false;
  }
  if (allRising) return 'rising';
  if (allFalling) return 'falling';
  return 'mixed';
}

/**
 * Compute QoQ % change from a sequence of quarterly GDP level prints.
 * FRED's GDP series is in billions of dollars (level). QoQ = (this / prev - 1) * 100.
 */
export function computeQoQSequence(quarterlyLevels: number[]): (number | null)[] {
  return quarterlyLevels.map((lvl, i) => {
    if (i < 1) return null;
    const prev = quarterlyLevels[i - 1];
    if (prev === 0) return null;
    return ((lvl - prev) / prev) * 100;
  });
}

export interface SahmRuleResult {
  threeMonthAvg: number;
  twelveMonthLow: number;
  delta: number;
  triggered: boolean;
}

export function computeSahmRule(
  monthlyUnemploymentRates: number[],
): SahmRuleResult | null {
  if (monthlyUnemploymentRates.length < 12) return null;
  const last3 = monthlyUnemploymentRates.slice(-3);
  const last12 = monthlyUnemploymentRates.slice(-12);
  const threeMonthAvg = last3.reduce((s, v) => s + v, 0) / 3;
  const twelveMonthLow = Math.min(...last12);
  const delta = threeMonthAvg - twelveMonthLow;
  return {
    threeMonthAvg,
    twelveMonthLow,
    delta,
    triggered: delta >= 0.5,
  };
}

/**
 * Last 3 month-over-month deltas of PAYEMS (total nonfarm payrolls, in thousands).
 * Each element is `levels[i] - levels[i-1]`, in thousands of jobs.
 * Returns empty array if fewer than 4 monthly levels are provided.
 */
export function computeRecentNFPChanges(monthlyPayemsLevels: number[]): number[] {
  if (monthlyPayemsLevels.length < 4) return [];
  const deltas: number[] = [];
  for (let i = monthlyPayemsLevels.length - 3; i < monthlyPayemsLevels.length; i++) {
    deltas.push(monthlyPayemsLevels[i] - monthlyPayemsLevels[i - 1]);
  }
  return deltas;
}

/**
 * Intersect two date-aligned series. Returns arrays of paired (xVal, yVal)
 * for dates present in BOTH inputs, sorted ascending by date.
 */
export interface AlignedPair {
  xs: number[];
  ys: number[];
}

export function alignByDate(
  a: Array<{ date: Date; value: number }>,
  b: Array<{ date: Date; value: number }>,
): AlignedPair {
  const bMap = new Map<string, number>();
  for (const row of b) bMap.set(row.date.toISOString().slice(0, 10), row.value);

  const xs: number[] = [];
  const ys: number[] = [];
  for (const row of a) {
    const key = row.date.toISOString().slice(0, 10);
    const bv = bMap.get(key);
    if (bv !== undefined) {
      xs.push(row.value);
      ys.push(bv);
    }
  }
  return { xs, ys };
}

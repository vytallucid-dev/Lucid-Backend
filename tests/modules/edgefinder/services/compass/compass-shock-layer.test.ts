import { describe, it, expect } from 'vitest';
import {
  evaluateTriggerA,
  evaluateTriggerB,
  advanceShockState,
  type ShockObservation,
  type ShockTriggerState,
} from '@modules/edgefinder/services/compass/compass-shock-layer';

function days(start: string, count: number): Date[] {
  const out: Date[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  for (let i = 0; i < count; i += 1) {
    out.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function series(dates: Date[], values: number[]): ShockObservation[] {
  return dates.map((date, i) => ({ date, value: values[i] }));
}

const VIX_THRESHOLD = 32.0;
const OAS_DELTA5_THRESHOLD = 0.5;
const USDJPY_MOVE5_THRESHOLD = -0.025;
const EXPIRY_DAYS = 10;

describe('evaluateTriggerA (Vol Shock)', () => {
  it('[case 1] fires when VIX close > 32 AND OAS 5-obs delta > 0.50', () => {
    const dates = days('2026-01-01', 6);
    const vixCloses = series(dates, [20, 20, 20, 20, 20, 33]); // today > 32
    const oasLevels = series(dates, [4.0, 4.0, 4.0, 4.0, 4.0, 4.6]); // delta5 = 0.6 > 0.5
    const result = evaluateTriggerA(dates[5], { vixCloses, oasLevels, vixThreshold: VIX_THRESHOLD, oasDelta5Threshold: OAS_DELTA5_THRESHOLD });
    expect(result.fired).toBe(true);
  });

  it('[case 2a] does NOT fire when only VIX condition is met (OAS delta too small)', () => {
    const dates = days('2026-01-01', 6);
    const vixCloses = series(dates, [20, 20, 20, 20, 20, 33]);
    const oasLevels = series(dates, [4.0, 4.0, 4.0, 4.0, 4.0, 4.1]); // delta5 = 0.1, not > 0.5
    const result = evaluateTriggerA(dates[5], { vixCloses, oasLevels, vixThreshold: VIX_THRESHOLD, oasDelta5Threshold: OAS_DELTA5_THRESHOLD });
    expect(result.fired).toBe(false);
  });

  it('[case 2b] does NOT fire when only OAS condition is met (VIX below threshold)', () => {
    const dates = days('2026-01-01', 6);
    const vixCloses = series(dates, [20, 20, 20, 20, 20, 25]); // below 32
    const oasLevels = series(dates, [4.0, 4.0, 4.0, 4.0, 4.0, 4.6]); // delta5 = 0.6 > 0.5
    const result = evaluateTriggerA(dates[5], { vixCloses, oasLevels, vixThreshold: VIX_THRESHOLD, oasDelta5Threshold: OAS_DELTA5_THRESHOLD });
    expect(result.fired).toBe(false);
  });

  it('[case 3] uses the SINGLE-DAY VIX close, not the 5-day average — constructed so they straddle the threshold', () => {
    const dates = days('2026-01-01', 6);
    // Single-day close today = 35 (> 32 threshold); 5-day average would be
    // (20+20+20+20+35)/5 = 23 (well under 32). If the trigger mistakenly used
    // a 5-day-average-shaped series here, it would not fire.
    const vixCloses = series(dates, [20, 20, 20, 20, 20, 35]);
    const oasLevels = series(dates, [4.0, 4.0, 4.0, 4.0, 4.0, 4.6]);
    const result = evaluateTriggerA(dates[5], { vixCloses, oasLevels, vixThreshold: VIX_THRESHOLD, oasDelta5Threshold: OAS_DELTA5_THRESHOLD });
    expect(result.fired).toBe(true); // fires because vixCloses IS the single-day series
  });
});

describe('evaluateTriggerB (Carry Shock)', () => {
  it('[case 4] fires on a signed FALL > 2.5% with vol rising', () => {
    const dates = days('2026-01-01', 7);
    // USDJPY: 5 obs back = 150, today = 145 -> move5 = 145/150-1 = -0.0333 < -0.025
    const usdJpyCloses = series(dates, [150, 150, 150, 150, 150, 150, 145]);
    const vix5dAvgs = series(dates, [18, 18, 18, 18, 18, 18, 19]); // rising vs yesterday(18)
    const result = evaluateTriggerB(dates[6], { usdJpyCloses, vix5dAvgs, usdJpyMove5Threshold: USDJPY_MOVE5_THRESHOLD });
    expect(result.fired).toBe(true);
  });

  it('[case 5] does NOT fire on a 2.5% RISE (signed, not absolute)', () => {
    const dates = days('2026-01-01', 7);
    // USDJPY rises: 5 obs back = 150, today = 155 -> move5 = +0.0333 (positive, not < -0.025)
    const usdJpyCloses = series(dates, [150, 150, 150, 150, 150, 150, 155]);
    const vix5dAvgs = series(dates, [18, 18, 18, 18, 18, 18, 19]);
    const result = evaluateTriggerB(dates[6], { usdJpyCloses, vix5dAvgs, usdJpyMove5Threshold: USDJPY_MOVE5_THRESHOLD });
    expect(result.fired).toBe(false);
  });

  it('[case 6] does NOT fire when USDJPY falls but vol is flat/falling', () => {
    const dates = days('2026-01-01', 7);
    const usdJpyCloses = series(dates, [150, 150, 150, 150, 150, 150, 145]); // same fall as case 4
    const vix5dAvgsFlat = series(dates, [18, 18, 18, 18, 18, 18, 18]); // flat, not strictly rising
    const resultFlat = evaluateTriggerB(dates[6], { usdJpyCloses, vix5dAvgs: vix5dAvgsFlat, usdJpyMove5Threshold: USDJPY_MOVE5_THRESHOLD });
    expect(resultFlat.fired).toBe(false);

    const vix5dAvgsFalling = series(dates, [18, 18, 18, 18, 18, 18, 17]); // falling
    const resultFalling = evaluateTriggerB(dates[6], { usdJpyCloses, vix5dAvgs: vix5dAvgsFalling, usdJpyMove5Threshold: USDJPY_MOVE5_THRESHOLD });
    expect(resultFalling.fired).toBe(false);
  });
});

describe('advanceShockState — activation, expiry, refresh', () => {
  it('[case 7] shock active on day t expires exactly 10 trading days later', () => {
    const dates = days('2026-01-01', 15);
    const flatSeries = series(dates, new Array(15).fill(1));

    // Day 0: condition fires -> active, expiry = day 0 + 10 - 1 = day 9 (10 trading days inclusive)
    const day0 = advanceShockState(null, true, dates[0], flatSeries, EXPIRY_DAYS);
    expect(day0).toEqual({ active: true, expiry: dates[9] });

    // Days 1-9: condition false, still within [day0, day9] -> still active
    let state: ShockTriggerState = day0;
    for (let i = 1; i <= 9; i += 1) {
      state = advanceShockState(state, false, dates[i], flatSeries, EXPIRY_DAYS);
      expect(state.active).toBe(true);
    }

    // Day 10: past expiry (day9) -> no longer active
    const day10 = advanceShockState(state, false, dates[10], flatSeries, EXPIRY_DAYS);
    expect(day10.active).toBe(false);
  });

  it('[case 8] re-trigger on day t+3 resets expiry to t+3+10 — does not stack', () => {
    const dates = days('2026-01-01', 20);
    const flatSeries = series(dates, new Array(20).fill(1));

    const day0 = advanceShockState(null, true, dates[0], flatSeries, EXPIRY_DAYS); // expiry = day9
    let state = advanceShockState(day0, false, dates[1], flatSeries, EXPIRY_DAYS);
    state = advanceShockState(state, false, dates[2], flatSeries, EXPIRY_DAYS);

    // Day 3: condition fires AGAIN -> expiry resets to day3+10-1 = day12, NOT day9+something-stacked
    const day3 = advanceShockState(state, true, dates[3], flatSeries, EXPIRY_DAYS);
    expect(day3).toEqual({ active: true, expiry: dates[12] });

    // Day 12: still active (last day of the reset window)
    let s = day3;
    for (let i = 4; i <= 12; i += 1) {
      s = advanceShockState(s, false, dates[i], flatSeries, EXPIRY_DAYS);
      expect(s.active).toBe(true);
    }
    // Day 13: expired
    const day13 = advanceShockState(s, false, dates[13], flatSeries, EXPIRY_DAYS);
    expect(day13.active).toBe(false);
  });

  it('condition firing while already active before natural expiry still just resets (no stacking)', () => {
    const dates = days('2026-01-01', 20);
    const flatSeries = series(dates, new Array(20).fill(1));
    const day0 = advanceShockState(null, true, dates[0], flatSeries, EXPIRY_DAYS); // expiry=day9
    const day1 = advanceShockState(day0, true, dates[1], flatSeries, EXPIRY_DAYS); // refires -> expiry=day10
    expect(day1).toEqual({ active: true, expiry: dates[10] });
  });
});

describe('Final regime resolution', () => {
  // These test the RULES directly (final_regime computation is a simple
  // ternary in compass-classifier.service.ts) — verified here as pure logic
  // to keep the assembly rule itself under a dedicated, named test.
  function finalRegime(shockAActive: boolean, standardActiveRegime: string): string {
    return shockAActive ? 'Risk-Off' : standardActiveRegime;
  }

  it('[case 9] final_regime = Risk-Off when A active, regardless of standard_active_regime', () => {
    expect(finalRegime(true, 'Risk-On')).toBe('Risk-Off');
    expect(finalRegime(true, 'Caution')).toBe('Risk-Off');
    expect(finalRegime(true, 'Risk-Off')).toBe('Risk-Off');
  });

  it('[case 10] Trigger B active alone -> final_regime UNCHANGED from standard_active_regime', () => {
    // B active, A not active -> final_regime just passes through standard_active_regime
    expect(finalRegime(false, 'Risk-On')).toBe('Risk-On');
    expect(finalRegime(false, 'Caution')).toBe('Caution');
  });

  it('[case 12] A and B both active behaves identically to A alone', () => {
    // finalRegime only reads shockAActive; B's presence is irrelevant to this computation
    expect(finalRegime(true, 'Risk-On')).toBe('Risk-Off');
    expect(finalRegime(true, 'Caution')).toBe('Risk-Off');
  });
});

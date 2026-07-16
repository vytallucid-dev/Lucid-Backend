import { describe, it, expect } from 'vitest';
import {
  scanForMostRecentEpisode,
  isWithinRedWindow,
  type CurveObservation,
} from '@modules/edgefinder/services/compass/compass-curve-state-machine';

function days(start: string, count: number): Date[] {
  const out: Date[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  for (let i = 0; i < count; i += 1) {
    out.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function obs(dates: Date[], values: number[]): CurveObservation[] {
  return dates.map((date, i) => ({ date, value: values[i] }));
}

describe('scanForMostRecentEpisode', () => {
  it('returns null when no inversion ever occurs', () => {
    const dates = days('2026-01-01', 20);
    const values = new Array(20).fill(0.3);
    expect(scanForMostRecentEpisode(obs(dates, values), 10, 5).mostRecentEpisode).toBeNull();
  });

  it('brief 1-2 day dips below zero do NOT begin an episode', () => {
    const dates = days('2026-01-01', 20);
    const values = new Array(20).fill(0.3);
    values[10] = -0.1;
    values[11] = -0.1;
    expect(scanForMostRecentEpisode(obs(dates, values), 10, 5).mostRecentEpisode).toBeNull();
  });

  it('begins an episode on the 10th consecutive negative observation, not before', () => {
    const dates = days('2026-01-01', 15);
    const values = [
      0.3, 0.3, // 0,1 positive
      -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, // 2..11: 10 negatives
      -0.1, -0.1, -0.1, // still negative, ongoing
    ];
    const result = scanForMostRecentEpisode(obs(dates, values), 10, 5);
    expect(result.mostRecentEpisode).not.toBeNull();
    expect(result.mostRecentEpisode?.inversionStart).toEqual(dates[2]);
    expect(result.mostRecentEpisode?.unInversionDate).toBeNull(); // still ongoing
  });

  it('un-inversion date is the FIRST day of the 5-obs positive run, not the 5th', () => {
    const negRun = new Array(10).fill(-0.1);
    const posRun = new Array(5).fill(0.1);
    const values = [0.3, 0.3, ...negRun, ...posRun];
    const dates = days('2026-01-01', values.length);
    const result = scanForMostRecentEpisode(obs(dates, values), 10, 5);
    expect(result.mostRecentEpisode?.inversionStart).toEqual(dates[2]);
    // negRun occupies indices 2..11 (10 elements); posRun starts at index 12
    expect(result.mostRecentEpisode?.unInversionDate).toEqual(dates[12]);
  });

  it('brief 1-2 day positive blips during an episode do NOT end it', () => {
    const values = [
      0.3, 0.3,
      ...new Array(10).fill(-0.1), // begins episode at index 2
      0.1, 0.1, // 2-day positive blip — not enough to un-invert
      -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, // back to negative
    ];
    const dates = days('2026-01-01', values.length);
    const result = scanForMostRecentEpisode(obs(dates, values), 10, 5);
    expect(result.mostRecentEpisode?.inversionStart).toEqual(dates[2]);
    expect(result.mostRecentEpisode?.unInversionDate).toBeNull(); // still ongoing after the blip
  });

  it('returns the MOST RECENT episode when multiple episodes occurred', () => {
    const negRun = new Array(10).fill(-0.1);
    const posRun = new Array(5).fill(0.1);
    // Episode 1: indices 0-14 (negRun 0-9, posRun 10-14)
    // calm: 15-24
    // Episode 2: indices 25-39 (negRun 25-34), un-inverts at 35-39
    const values = [
      ...negRun,
      ...posRun,
      ...new Array(10).fill(0.2),
      ...negRun,
      ...posRun,
    ];
    const dates = days('2026-01-01', values.length);
    const result = scanForMostRecentEpisode(obs(dates, values), 10, 5);
    expect(result.mostRecentEpisode?.inversionStart).toEqual(dates[25]);
    expect(result.mostRecentEpisode?.unInversionDate).toEqual(dates[35]);
  });

  it('t10y2y(t) exactly 0 counts as NOT inverted (strict < 0 for inversion)', () => {
    const values = [0.3, 0.3, ...new Array(10).fill(0)];
    const dates = days('2026-01-01', values.length);
    expect(scanForMostRecentEpisode(obs(dates, values), 10, 5).mostRecentEpisode).toBeNull();
  });
});

describe('isWithinRedWindow', () => {
  it('true on the un-inversion date itself (inclusive start)', () => {
    const dates = days('2026-01-01', 70);
    const values = new Array(70).fill(0.1);
    const series = obs(dates, values);
    expect(isWithinRedWindow(series, dates[10], dates[10], 60)).toBe(true);
  });

  it('true at exactly the 60th trading day (inclusive end)', () => {
    const dates = days('2026-01-01', 80);
    const values = new Array(80).fill(0.1);
    const series = obs(dates, values);
    expect(isWithinRedWindow(series, dates[10], dates[10 + 59], 60)).toBe(true);
  });

  it('false on the 61st trading day', () => {
    const dates = days('2026-01-01', 80);
    const values = new Array(80).fill(0.1);
    const series = obs(dates, values);
    expect(isWithinRedWindow(series, dates[10], dates[10 + 60], 60)).toBe(false);
  });

  it('false when asOfDate is before unInversionDate', () => {
    const dates = days('2026-01-01', 20);
    const values = new Array(20).fill(0.1);
    const series = obs(dates, values);
    expect(isWithinRedWindow(series, dates[10], dates[5], 60)).toBe(false);
  });

  it('false when either date is not present in the series', () => {
    const dates = days('2026-01-01', 20);
    const values = new Array(20).fill(0.1);
    const series = obs(dates, values);
    const missingDate = new Date('2099-01-01T00:00:00.000Z');
    expect(isWithinRedWindow(series, missingDate, dates[5], 60)).toBe(false);
    expect(isWithinRedWindow(series, dates[5], missingDate, 60)).toBe(false);
  });
});

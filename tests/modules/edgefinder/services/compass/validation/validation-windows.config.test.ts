import { describe, it, expect } from 'vitest';
import {
  VALIDATION_WINDOWS,
  getWindowByName,
} from '@modules/edgefinder/services/compass/validation/validation-windows.config';

describe('VALIDATION_WINDOWS', () => {
  it('contains exactly 4 windows', () => {
    expect(VALIDATION_WINDOWS).toHaveLength(4);
  });

  it('all windows have ascending start->end dates', () => {
    for (const w of VALIDATION_WINDOWS) {
      expect(w.startDate.getTime()).toBeLessThan(w.endDate.getTime());
    }
  });

  it('all peak dates fall within their window range', () => {
    for (const w of VALIDATION_WINDOWS) {
      expect(w.peakDate.getTime()).toBeGreaterThanOrEqual(w.startDate.getTime());
      expect(w.peakDate.getTime()).toBeLessThanOrEqual(w.endDate.getTime());
    }
  });

  it('all crisis-core ranges fall within their window', () => {
    for (const w of VALIDATION_WINDOWS) {
      expect(w.crisisCore.start.getTime()).toBeGreaterThanOrEqual(
        w.startDate.getTime(),
      );
      expect(w.crisisCore.end.getTime()).toBeLessThanOrEqual(
        w.endDate.getTime(),
      );
      expect(w.crisisCore.start.getTime()).toBeLessThanOrEqual(
        w.crisisCore.end.getTime(),
      );
    }
  });

  it('window names are unique', () => {
    const names = VALIDATION_WINDOWS.map((w) => w.windowName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('2008 and 2020 require crisis override; 2022 and 2024 do not', () => {
    expect(getWindowByName('2008_GFC').requiresCrisisOverride).toBe(true);
    expect(getWindowByName('2020_COVID').requiresCrisisOverride).toBe(true);
    expect(getWindowByName('2022_HIKES').requiresCrisisOverride).toBe(false);
    expect(getWindowByName('2024_YEN_UNWIND').requiresCrisisOverride).toBe(false);
  });

  it('minRiskOffPercent scales by window severity (2008,2020:60 > 2022:30 > 2024:10)', () => {
    expect(getWindowByName('2008_GFC').minRiskOffPercent).toBe(60);
    expect(getWindowByName('2020_COVID').minRiskOffPercent).toBe(60);
    expect(getWindowByName('2022_HIKES').minRiskOffPercent).toBe(30);
    expect(getWindowByName('2024_YEN_UNWIND').minRiskOffPercent).toBe(10);
  });

  it('getWindowByName throws on unknown name', () => {
    expect(() =>
      getWindowByName('NONEXISTENT' as unknown as '2008_GFC'),
    ).toThrow(/Unknown validation window/);
  });
});

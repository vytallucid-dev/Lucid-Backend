import { describe, it, expect } from 'vitest';
import {
  effectiveRegime,
  evalCriterion,
} from '@modules/edgefinder/services/compass/validation/replay/replay-harness.service';
import { WINDOWS } from '@modules/edgefinder/services/compass/validation/replay/windows';
import type { ReplayRow } from '@modules/edgefinder/services/compass/validation/replay/engine';

/**
 * Phase C rewrote this suite.
 *
 * The previous tests exercised a harness that READ compass_classifications and
 * required `crisis_override_fired` on a peak date. Both are gone: the harness now
 * replays, and that criterion was structurally unsatisfiable (Phase 4 retired the
 * crisis clause and the classifier writes the column false unconditionally, so
 * 2008_GFC and 2020_COVID could not pass under any data). Tests asserting the old
 * behaviour would have been asserting the defect.
 */

function row(over: Partial<ReplayRow>): ReplayRow {
  return {
    date: '2020-03-16',
    inWindow: true,
    activeRegime: 'Caution',
    finalRegime: 'Caution',
    triggerAFired: false,
    shockAActive: false,
    redWeight: 0,
    greenWeight: 0,
    ...over,
  } as ReplayRow;
}

describe('effectiveRegime', () => {
  it('prefers finalRegime — the Shock Layer writes ONLY that field', () => {
    // This is the single most consequential fix in the harness. Trigger A's
    // Risk-Off override never touches activeRegime, by design, so a harness
    // reading activeRegime is blind to the entire Phase 4 deliverable.
    expect(effectiveRegime(row({ activeRegime: 'Caution', finalRegime: 'Risk-Off' }))).toBe('Risk-Off');
  });

  it('falls back to activeRegime when finalRegime is empty', () => {
    // 45 pre-Phase-4 rows carried final_regime = '' in the live table before it
    // was archived. Reading '' as a regime would count them as neither Risk-Off
    // nor Risk-On and silently shrink every denominator.
    expect(effectiveRegime(row({ activeRegime: 'Risk-On', finalRegime: '' as never }))).toBe('Risk-On');
  });
});

describe('evalCriterion', () => {
  const w = WINDOWS[0];

  it('min_risk_off_pct counts finalRegime, so a Trigger A day counts', () => {
    const rows = [
      row({ activeRegime: 'Caution', finalRegime: 'Risk-Off' }),
      row({ activeRegime: 'Caution', finalRegime: 'Caution' }),
    ];
    const r = evalCriterion({ kind: 'min_risk_off_pct', pct: 50 }, w, rows);
    expect(r.passed).toBe(true);
    expect(r.detail).toContain('1/2');
  });

  it('min_risk_off_days', () => {
    const rows = [row({ finalRegime: 'Risk-Off' }), row({ finalRegime: 'Risk-Off' })];
    expect(evalCriterion({ kind: 'min_risk_off_days', days: 3 }, w, rows).passed).toBe(false);
    expect(evalCriterion({ kind: 'min_risk_off_days', days: 2 }, w, rows).passed).toBe(true);
  });

  it('max_risk_off_run measures the LONGEST consecutive run', () => {
    const rows = [
      row({ finalRegime: 'Risk-Off' }),
      row({ finalRegime: 'Risk-Off' }),
      row({ finalRegime: 'Caution' }),
      row({ finalRegime: 'Risk-Off' }),
    ];
    expect(evalCriterion({ kind: 'max_risk_off_run', days: 2 }, w, rows).passed).toBe(true);
    expect(evalCriterion({ kind: 'max_risk_off_run', days: 1 }, w, rows).passed).toBe(false);
  });

  it('trigger_a_fires_between passes only inside the stated dates', () => {
    const rows = [
      row({ date: '2008-09-17', triggerAFired: true }),
      row({ date: '2008-12-30', triggerAFired: false }),
    ];
    const inside = evalCriterion(
      { kind: 'trigger_a_fires_between', start: new Date('2008-09-15T00:00:00Z'), end: new Date('2008-09-30T00:00:00Z') },
      w,
      rows,
    );
    expect(inside.passed).toBe(true);

    const outside = evalCriterion(
      { kind: 'trigger_a_fires_between', start: new Date('2008-11-01T00:00:00Z'), end: new Date('2008-11-30T00:00:00Z') },
      w,
      rows,
    );
    expect(outside.passed).toBe(false);
  });

  it('trigger_a_never_fires is a real negative test', () => {
    expect(evalCriterion({ kind: 'trigger_a_never_fires' }, w, [row({})]).passed).toBe(true);
    expect(
      evalCriterion({ kind: 'trigger_a_never_fires' }, w, [row({ triggerAFired: true })]).passed,
    ).toBe(false);
  });

  it('crisis_override_on_peak always fails and says why', () => {
    // Retained ONLY so a legacy spec cannot silently pass.
    const r = evalCriterion({ kind: 'crisis_override_on_peak' }, w, [row({})]);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('structurally unsatisfiable');
  });

  it('no_false_risk_on_in_core uses finalRegime inside the core dates', () => {
    const rows = [row({ date: '2008-09-16', activeRegime: 'Risk-On', finalRegime: 'Risk-On' })];
    expect(evalCriterion({ kind: 'no_false_risk_on_in_core' }, w, rows).passed).toBe(false);
  });
});

describe('the eight window specifications', () => {
  it('there are exactly eight', () => {
    expect(WINDOWS).toHaveLength(8);
    expect(WINDOWS.map((w) => w.id)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8']);
  });

  it('no window still uses the unsatisfiable crisis-override criterion', () => {
    for (const w of WINDOWS) {
      expect(w.criteria.map((c) => c.kind)).not.toContain('crisis_override_on_peak');
    }
  });

  it('V6 is specified as a spike, not a duration', () => {
    // The yen unwind was a three-day event inside a four-month window; the old
    // criterion demanded Risk-Off on >=10% of it, i.e. nine days.
    const v6 = WINDOWS.find((w) => w.id === 'V6')!;
    expect(v6.criteria.map((c) => c.kind)).toContain('trigger_a_fires_between');
    expect(v6.criteria.map((c) => c.kind)).not.toContain('min_risk_off_pct');
  });

  it('every window has a replayFrom that precedes its assertion window', () => {
    // The engine needs lead-in to warm up 50-observation SMAs and the
    // persistence machine; assertions are scoped to [startDate, endDate].
    for (const w of WINDOWS) {
      expect(w.replayFrom.getTime()).toBeLessThan(w.startDate.getTime());
      expect(w.startDate.getTime()).toBeLessThan(w.endDate.getTime());
    }
  });
});

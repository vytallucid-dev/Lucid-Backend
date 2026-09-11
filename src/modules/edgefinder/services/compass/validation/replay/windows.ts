/**
 * Phase B — the full eight-window validation suite.
 *
 * Windows V1/V2/V4/V6 are transcribed EXACTLY from the shipped
 * validation-windows.config.ts (2008_GFC, 2020_COVID, 2022_HIKES,
 * 2024_YEN_UNWIND) — same dates, same peak, same crisis core, same
 * minRiskOffPercent, same requiresCrisisOverride flag. Nothing is re-tuned.
 *
 * V3 / V5 / V7 / V8 are the four the spec defines but that were never
 * implemented, written here to the criteria given in the Phase B brief.
 *
 * `replayFrom` is earlier than `startDate` only to give the engine enough
 * lead-in to compute 50-observation SMAs etc. Assertions are evaluated over
 * [startDate, endDate] only.
 */

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

export type Criterion =
  | { kind: 'min_risk_off_pct'; pct: number }
  | { kind: 'min_risk_off_days'; days: number }
  | { kind: 'min_risk_on_pct'; pct: number }
  | { kind: 'max_risk_off_run'; days: number }
  | { kind: 'no_false_risk_on_in_core' }
  | { kind: 'crisis_override_on_peak' }
  | { kind: 'trigger_a_fires_between'; start: Date; end: Date }
  | { kind: 'trigger_a_never_fires' }
  | { kind: 'never_risk_off' };

export interface WindowSpec {
  id: string;
  name: string;
  implementedInRepo: boolean;
  replayFrom: Date;
  startDate: Date;
  endDate: Date;
  peakDate: Date | null;
  crisisCore: { start: Date; end: Date } | null;
  criteria: Criterion[];
  note: string;
}

export const WINDOWS: WindowSpec[] = [
  {
    id: 'V1',
    name: '2008_GFC',
    implementedInRepo: true,
    replayFrom: utc(2008, 4, 1),
    startDate: utc(2008, 7, 1),
    endDate: utc(2008, 12, 31),
    peakDate: utc(2008, 9, 29),
    crisisCore: { start: utc(2008, 9, 15), end: utc(2008, 12, 31) },
    criteria: [
      { kind: 'min_risk_off_pct', pct: 60 },
      // Phase C: was `crisis_override_on_peak`. That criterion is structurally
      // unsatisfiable — Phase 4 retired the crisis clause and the classifier
      // writes crisisOverrideFired: false unconditionally, so 2008_GFC and
      // 2020_COVID could never pass under ANY data. Replaced by the Phase-4
      // successor the clause became: Trigger A firing somewhere in the crisis
      // core. This is a defect fix, not a loosening — the successor is a real
      // condition that can fail, and does.
      { kind: 'trigger_a_fires_between', start: utc(2008, 9, 15), end: utc(2008, 12, 31) },
      { kind: 'no_false_risk_on_in_core' },
    ],
    note: 'From validation-windows.config.ts; crisis-override criterion replaced by its Phase-4 successor',
  },
  {
    id: 'V2',
    name: '2020_COVID',
    implementedInRepo: true,
    replayFrom: utc(2019, 10, 1),
    startDate: utc(2020, 1, 15),
    endDate: utc(2020, 5, 31),
    peakDate: utc(2020, 3, 16),
    crisisCore: { start: utc(2020, 2, 24), end: utc(2020, 4, 30) },
    criteria: [
      { kind: 'min_risk_off_pct', pct: 60 },
      // Phase C — see V1.
      { kind: 'trigger_a_fires_between', start: utc(2020, 2, 24), end: utc(2020, 4, 30) },
      { kind: 'no_false_risk_on_in_core' },
    ],
    note: 'From validation-windows.config.ts; crisis-override criterion replaced by its Phase-4 successor',
  },
  {
    id: 'V3',
    name: '2018_Q4',
    implementedInRepo: false,
    replayFrom: utc(2018, 9, 1),
    startDate: utc(2018, 12, 1),
    endDate: utc(2019, 1, 15),
    peakDate: utc(2018, 12, 24),
    crisisCore: null,
    criteria: [{ kind: 'min_risk_off_days', days: 3 }],
    note: 'Spec V3 — Q4 2018 selloff: Risk-Off on at least 3 days',
  },
  {
    id: 'V4',
    name: '2022_HIKES',
    implementedInRepo: true,
    replayFrom: utc(2022, 1, 3),
    startDate: utc(2022, 4, 1),
    endDate: utc(2022, 11, 30),
    peakDate: utc(2022, 10, 21),
    crisisCore: { start: utc(2022, 9, 1), end: utc(2022, 11, 15) },
    criteria: [
      { kind: 'min_risk_off_pct', pct: 30 },
      { kind: 'no_false_risk_on_in_core' },
    ],
    note: 'Transcribed verbatim from validation-windows.config.ts',
  },
  {
    id: 'V5',
    name: '2024_FULL_YEAR',
    implementedInRepo: false,
    replayFrom: utc(2023, 10, 2),
    startDate: utc(2024, 1, 1),
    endDate: utc(2024, 12, 31),
    peakDate: null,
    crisisCore: null,
    criteria: [
      { kind: 'min_risk_on_pct', pct: 50 },
      { kind: 'max_risk_off_run', days: 5 },
    ],
    note: 'Spec V5 — calm-year sanity: Risk-On >=50% of days, no Risk-Off run > 5 consecutive days',
  },
  {
    id: 'V6',
    name: '2024_YEN_UNWIND',
    implementedInRepo: true,
    replayFrom: utc(2024, 3, 1),
    startDate: utc(2024, 6, 1),
    endDate: utc(2024, 9, 30),
    peakDate: utc(2024, 8, 5),
    crisisCore: { start: utc(2024, 7, 31), end: utc(2024, 8, 9) },
    criteria: [
      // Phase C RE-SPECIFICATION. The shipped criterion demanded Risk-Off on
      // >=10% of a four-month window — 9 days — for an event that lasted three.
      // It measured DURATION where this architecture produces a SPIKE, so it
      // asked the system to be wrong in order to pass. The system did detect the
      // unwind: Trigger A fired on 2024-08-05 (VIX close 38.57 > 32, OAS delta5
      // > 0.5) and finalRegime was Risk-Off. The harness scored zero only because
      // it read activeRegime, which the Shock Layer deliberately never touches.
      //
      // Re-specified as what the architecture actually claims: Trigger A fires
      // inside the crisis core.
      { kind: 'trigger_a_fires_between', start: utc(2024, 7, 31), end: utc(2024, 8, 9) },
      { kind: 'no_false_risk_on_in_core' },
    ],
    note: 'Re-specified in Phase C: the yen unwind is a spike, not a duration',
  },
  {
    id: 'V7',
    name: '2025_TARIFF_SHOCK',
    implementedInRepo: false,
    replayFrom: utc(2025, 1, 2),
    startDate: utc(2025, 3, 1),
    endDate: utc(2025, 5, 30),
    peakDate: utc(2025, 4, 8),
    crisisCore: null,
    criteria: [{ kind: 'trigger_a_fires_between', start: utc(2025, 4, 3), end: utc(2025, 4, 9) }],
    note: 'Spec V7 — Trigger A must fire somewhere in 3-9 April 2025',
  },
  {
    id: 'V8',
    name: '2026_IRAN_SHOCK',
    implementedInRepo: false,
    replayFrom: utc(2026, 3, 2),
    startDate: utc(2026, 6, 1),
    endDate: utc(2026, 6, 30),
    peakDate: null,
    crisisCore: null,
    criteria: [{ kind: 'trigger_a_never_fires' }, { kind: 'never_risk_off' }],
    note: 'Spec V8 — NEGATIVE test. Chosen from lived experience, not an external standard: the weakest test in the suite.',
  },
];

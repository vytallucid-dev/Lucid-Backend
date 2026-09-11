import { describe, it, expect } from 'vitest';
import { TEMPLATES, render, explanation } from '@modules/edgefinder/services/compass/modules/templates';
import { synthesise, assertTraceable } from '@modules/edgefinder/services/compass/modules/synthesis';
import { buildModuleStates } from '@modules/edgefinder/services/compass/modules/modules';
import type {
  ModuleReading,
  ModuleCode,
} from '@modules/edgefinder/services/compass/modules/module-types';

function reading(over: Partial<ModuleReading> & Pick<ModuleReading, 'moduleCode' | 'readingCode'>): ModuleReading {
  return {
    title: over.readingCode,
    colorBand: null,
    isVoting: false,
    weight: null,
    stateLabel: null,
    valueNumeric: null,
    valueText: null,
    unit: null,
    sourceCode: 'TEST',
    sourceAsOf: new Date('2026-09-09T00:00:00Z'),
    stalenessState: 'FRESH',
    stalenessDays: 0,
    explanation: null,
    ...over,
  };
}

const baseRegime = {
  active: 'Caution',
  candidate: 'Caution',
  final: 'Caution',
  green: 6,
  yellow: 2,
  red: 0,
  total: 8,
  pendingLabel: null,
  pendingCount: 0,
  required: 3,
  shockAActive: false,
  shockAExpiry: null,
};

const votingReadings: ModuleReading[] = [
  reading({ moduleCode: 'VOL_CREDIT', readingCode: 'VIX_5D_AVG', isVoting: true, colorBand: 'GREEN', weight: 1 }),
  reading({ moduleCode: 'ECON_DATA', readingCode: 'US_DATA_STACK', isVoting: true, colorBand: 'YELLOW', weight: 2 }),
];

describe('layer 2 — traceability', () => {
  it('every sentence carries at least one trace, and all traces resolve', () => {
    const states = buildModuleStates(votingReadings);
    const s = synthesise({
      readings: votingReadings,
      states,
      regime: baseRegime,
      historyDays: 100,
      historyStartDate: '2026-01-01',
    });
    expect(s.sentences.length).toBeGreaterThan(0);
    expect(() => assertTraceable(s, votingReadings)).not.toThrow();
  });

  it('REJECTS a sentence whose trace has no matching reading', () => {
    // The guarantee: a synthesis claim with no supporting module reading fails
    // here rather than reaching a user.
    const bad = {
      sentences: [
        {
          templateId: 'synth.regime',
          params: {},
          text: 'x',
          traces: [{ moduleCode: 'YIELDS' as ModuleCode, readingCode: 'DOES_NOT_EXIST' }],
        },
      ],
      disagreements: [],
    };
    expect(() => assertTraceable(bad, votingReadings)).toThrow(/no reading for this date/);
  });

  it('REJECTS a sentence with no traces at all', () => {
    const bad = {
      sentences: [{ templateId: 'synth.regime', params: {}, text: 'x', traces: [] }],
      disagreements: [],
    };
    expect(() => assertTraceable(bad, votingReadings)).toThrow(/no traces/);
  });

  it('produces nothing at all when there are no readings — it never invents', () => {
    const s = synthesise({
      readings: [],
      states: buildModuleStates([]),
      regime: baseRegime,
      historyDays: 0,
      historyStartDate: null,
    });
    expect(s.sentences).toHaveLength(0);
    expect(s.disagreements).toHaveLength(0);
  });
});

describe('layer 2 — disagreement is surfaced, not averaged', () => {
  it('flags the curve reading healthy while real yields are rising', () => {
    const readings = [
      ...votingReadings,
      reading({ moduleCode: 'YIELDS', readingCode: 'CURVE_2S10S', isVoting: true, colorBand: 'GREEN', weight: 1 }),
      reading({ moduleCode: 'YIELDS', readingCode: 'R1_REAL_YIELD_SHOCK', colorBand: 'RED', valueNumeric: 72 }),
    ];
    const s = synthesise({
      readings,
      states: buildModuleStates(readings),
      regime: baseRegime,
      historyDays: 100,
      historyStartDate: '2026-01-01',
    });
    expect(s.disagreements.map((d) => d.templateId)).toContain('disagree.curve_vs_real_yields');
    expect(() => assertTraceable(s, readings)).not.toThrow();
  });

  // ACM was removed (see readings-builder.service.ts): it was the only manually
  // refreshed source in Compass, and a display-only series carrying a monthly
  // chore is the wrong trade against 40+ indicators already maintained by hand.
  // Kim-Wright stays. These two tests previously asserted the two-model clash
  // sentence; what has to hold now is that a lone term-premium reading produces
  // NO disagreement — synthesising one from a single number would be inventing
  // a conflict, which is the opposite of what this layer is for.
  it('reports no term-premium clash when only one model is present', () => {
    const readings = [
      ...votingReadings,
      reading({ moduleCode: 'YIELDS', readingCode: 'TERM_PREMIUM_KW', valueNumeric: 0.31 }),
    ];
    const s = synthesise({
      readings,
      states: buildModuleStates(readings),
      regime: baseRegime,
      historyDays: 100,
      historyStartDate: '2026-01-01',
    });
    expect(s.disagreements.map((x) => x.templateId)).not.toContain('disagree.term_premium_models');
    expect(() => assertTraceable(s, readings)).not.toThrow();
  });

  it('does not reference a retired reading code anywhere in the output', () => {
    const readings = [
      ...votingReadings,
      reading({ moduleCode: 'YIELDS', readingCode: 'TERM_PREMIUM_KW', valueNumeric: 0.72 }),
    ];
    const s = synthesise({
      readings,
      states: buildModuleStates(readings),
      regime: baseRegime,
      historyDays: 100,
      historyStartDate: '2026-01-01',
    });
    const traced = [...s.sentences, ...s.disagreements].flatMap((x) => x.traces.map((t) => t.readingCode));
    expect(traced).not.toContain('TERM_PREMIUM_ACM');
  });
});

describe('layer 2 — degrades gracefully on a short history', () => {
  it('says so rather than rendering a comparison against one data point', () => {
    const s = synthesise({
      readings: votingReadings,
      states: buildModuleStates(votingReadings),
      regime: baseRegime,
      historyDays: 1,
      historyStartDate: '2026-09-09',
    });
    const note = s.sentences.find((x) => x.templateId === 'synth.history_restart');
    expect(note).toBeDefined();
    expect(note!.text).toContain('1 trading day');
  });

  it('drops the notice once enough history has accumulated', () => {
    const s = synthesise({
      readings: votingReadings,
      states: buildModuleStates(votingReadings),
      regime: baseRegime,
      historyDays: 60,
      historyStartDate: '2026-01-01',
    });
    expect(s.sentences.map((x) => x.templateId)).not.toContain('synth.history_restart');
  });
});

describe('module states', () => {
  it('Policy Stance has NO verdict — it describes, it does not judge', () => {
    const readings = [
      reading({ moduleCode: 'POLICY_STANCE', readingCode: 'POLICY_RATE_US', valueNumeric: 3.625 }),
    ];
    const policy = buildModuleStates(readings).find((s) => s.moduleCode === 'POLICY_STANCE')!;
    expect(policy.verdictBand).toBeNull();
  });

  it('a module verdict ignores non-voting readings entirely', () => {
    // A display reading must never be able to move a vote — that separation is
    // what makes it safe to add readings.
    const readings = [
      reading({ moduleCode: 'YIELDS', readingCode: 'CURVE_2S10S', isVoting: true, colorBand: 'GREEN', weight: 1 }),
      reading({ moduleCode: 'YIELDS', readingCode: 'R1_REAL_YIELD_SHOCK', colorBand: 'RED' }),
    ];
    const yields = buildModuleStates(readings).find((s) => s.moduleCode === 'YIELDS')!;
    expect(yields.verdictBand).toBe('GREEN');
  });
});

describe('template registry — language discipline', () => {
  const SAMPLE = {
    bp: 60, level: 0.4, delta30: 0.1, acm: 0.68, kw: 0.89, value: 2.4, real: 2.4,
    country: 'US', twoYear: 3.6, policy: 3.625, gapBp: 74, delta10: 0.1,
    cpi: 'GREEN', gdp: 'GREEN', jobs: 'GREEN', devPct: 1.3, move5Pct: 0.9,
    bank: 'Fed', regime: 'Caution', green: 6, yellow: 2, red: 0, total: 8,
    active: 'Caution', candidate: 'Risk-On', count: 1, required: 3,
    expiry: '2026-09-20', detail: 'x', gap: 0.2, signConflict: false,
    greenModules: 'Yields', redModules: 'Economic Data', date: '2026-09-09', days: 1,
    redInputs: 2, fed: 3.625, boj: 1, ecb: 2.25,
  };

  const PRESCRIPTIVE = /\b(favour|favor|buy|sell|short|long the|should|recommend|target|allocate|overweight|underweight)\b/i;
  const PREDICTIVE = /\b(will|expect|forecast|predicts?|going to|set to|poised)\b/i;

  it('no template renders prescriptive language', () => {
    // A regulatory boundary as much as an editorial one.
    for (const [id, fn] of Object.entries(TEMPLATES)) {
      const text = fn(SAMPLE);
      expect(PRESCRIPTIVE.test(text), `${id}: "${text}"`).toBe(false);
    }
  });

  it('no template renders predictive language', () => {
    // Phase B found no forward-return effect at any horizon for anything, so
    // predictive phrasing would be stating something known to be false.
    for (const [id, fn] of Object.entries(TEMPLATES)) {
      const text = fn(SAMPLE);
      expect(PREDICTIVE.test(text), `${id}: "${text}"`).toBe(false);
    }
  });

  it('every template renders a non-empty string', () => {
    for (const [id, fn] of Object.entries(TEMPLATES)) {
      expect(fn(SAMPLE).trim().length, id).toBeGreaterThan(0);
    }
  });

  it('render() throws on an unknown template rather than rendering nothing', () => {
    expect(() => render({ templateId: 'nope.nope', params: {} })).toThrow(/Unknown template/);
    expect(() => explanation('nope.nope')).toThrow(/Unknown template/);
  });

  it('missing numeric params render as an em-dash, never as NaN or undefined', () => {
    for (const [id, fn] of Object.entries(TEMPLATES)) {
      const text = fn({});
      expect(text, id).not.toMatch(/NaN|undefined|null/);
    }
  });
});

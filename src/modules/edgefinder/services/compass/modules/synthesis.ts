import { render, explanation } from './templates';
import { MODULE_TITLES } from './module-types';
import type {
  ModuleCode,
  ModuleReading,
  ModuleState,
  Sentence,
  SentenceTrace,
  Synthesis,
} from './module-types';

/**
 * Layer 2 — a deterministic, traceable description of the market's state.
 *
 * FOUR RULES, all structural rather than stylistic:
 *
 *   DETERMINISTIC. Every sentence is a template rendered from numbers. Nothing
 *   is generated. Given the same readings, always the same words.
 *
 *   TRACEABLE. Every sentence carries at least one trace, and every trace must
 *   resolve to a reading present for the same date. `assertTraceable` enforces
 *   it and a test runs it — a claim with no supporting reading fails the build
 *   rather than reaching the page.
 *
 *   IT SURFACES DISAGREEMENT. Conflict between modules, and between the two
 *   term-premium models, is reported as its own sentence family. It is never
 *   averaged into a single number, because the disagreement is the information.
 *
 *   IT DESCRIBES, NEVER RECOMMENDS. No action, no direction, no forecast.
 *
 * WHAT IS DELIBERATELY ABSENT: the "why the dollar is moving" family, which
 * would have been driven by R3 (global versus US-specific long-end moves). R3
 * was tested out of sample in Phase C against criteria fixed in advance and
 * FAILED: the characteristic split holds after 2015 but inverts before it, and
 * the separation reverses sign across the quantile sweep. It is not rendered.
 */

function sentence(
  templateId: string,
  params: Record<string, string | number | boolean | null>,
  traces: SentenceTrace[],
): Sentence {
  const ref = explanation(templateId, params);
  return { templateId, params, text: render(ref), traces };
}

function reading(readings: ModuleReading[], code: string): ModuleReading | undefined {
  return readings.find((r) => r.readingCode === code);
}

export interface SynthesisInput {
  readings: ModuleReading[];
  states: ModuleState[];
  regime: {
    active: string;
    candidate: string;
    final: string;
    green: number;
    yellow: number;
    red: number;
    total: number;
    pendingLabel: string | null;
    pendingCount: number;
    required: number;
    shockAActive: boolean;
    shockAExpiry: string | null;
  };
  /** Trading days of live history so far. Layer 2 must degrade, not mislead. */
  historyDays: number;
  historyStartDate: string | null;
}

export function synthesise(input: SynthesisInput): Synthesis {
  const { readings, states, regime } = input;
  const sentences: Sentence[] = [];
  const disagreements: Sentence[] = [];

  // ------------------------------------------------------------- the reading
  // Traced to whichever voting readings exist, because the vote IS those inputs.
  const votingTraces: SentenceTrace[] = readings
    .filter((r) => r.isVoting)
    .map((r) => ({ moduleCode: r.moduleCode, readingCode: r.readingCode }));

  if (votingTraces.length > 0) {
    sentences.push(
      sentence(
        'synth.regime',
        {
          regime: regime.final,
          green: regime.green,
          yellow: regime.yellow,
          red: regime.red,
          total: regime.total,
        },
        votingTraces,
      ),
    );

    if (regime.pendingLabel && regime.pendingCount > 0) {
      sentences.push(
        sentence(
          'synth.regime.pending',
          {
            active: regime.active,
            candidate: regime.pendingLabel,
            count: regime.pendingCount,
            required: regime.required,
          },
          votingTraces,
        ),
      );
    }
  }

  if (regime.shockAActive) {
    const vix = reading(readings, 'VIX_5D_AVG');
    const oas = reading(readings, 'HY_OAS');
    const traces: SentenceTrace[] = [];
    if (vix) traces.push({ moduleCode: vix.moduleCode, readingCode: vix.readingCode });
    if (oas) traces.push({ moduleCode: oas.moduleCode, readingCode: oas.readingCode });
    if (traces.length > 0) {
      sentences.push(
        sentence('synth.shock', { expiry: regime.shockAExpiry ?? 'expiry' }, traces),
      );
    }
  }

  // ---------------------------------------------------- curve vs real yields
  // The single most actionable finding in Phase B, surfaced whenever the
  // combination it describes is actually present.
  const r1 = reading(readings, 'R1_REAL_YIELD_SHOCK');
  const curve = reading(readings, 'CURVE_2S10S');
  if (
    r1 &&
    curve &&
    r1.valueNumeric !== null &&
    (r1.colorBand === 'RED' || r1.colorBand === 'YELLOW') &&
    curve.colorBand === 'GREEN'
  ) {
    const traces: SentenceTrace[] = [
      { moduleCode: r1.moduleCode, readingCode: r1.readingCode },
      { moduleCode: curve.moduleCode, readingCode: curve.readingCode },
    ];
    sentences.push(sentence('synth.yields_calm_but_shock', { bp: r1.valueNumeric }, traces));
    disagreements.push(sentence('disagree.curve_vs_real_yields', {}, traces));
  }

  // The term-premium model clash sentence is gone with ACM. It compared two
  // estimates of the same unobservable quantity and reported their gap, which
  // needed both series; with one model there is no clash to report, and
  // manufacturing a disagreement sentence from a single number would be worse
  // than saying nothing. The point it made — that term premium is a model
  // output and models differ — now lives in that reading's standing copy,
  // where it is true whether or not a second series is on the page.

  // ------------------------------------------------------- module divergence
  const green = states.filter((s) => s.verdictBand === 'GREEN');
  const red = states.filter((s) => s.verdictBand === 'RED');
  if (green.length > 0 && red.length > 0) {
    const traces: SentenceTrace[] = [...green, ...red].flatMap((s) =>
      s.readingCodes.slice(0, 1).map((c) => ({ moduleCode: s.moduleCode, readingCode: c })),
    );
    if (traces.length > 0) {
      disagreements.push(
        sentence(
          'disagree.modules',
          {
            greenModules: green.map((s) => MODULE_TITLES[s.moduleCode]).join(' and '),
            redModules: red.map((s) => MODULE_TITLES[s.moduleCode]).join(' and '),
          },
          traces,
        ),
      );
    }
  }

  // ------------------------------------------------------ degrade gracefully
  // Live history was archived and restarted, so period-over-period readings are
  // unavailable until days accumulate. Saying so is better than rendering a
  // comparison against one data point.
  if (input.historyDays < 20 && input.historyStartDate && votingTraces.length > 0) {
    sentences.push(
      sentence(
        'synth.history_restart',
        { date: input.historyStartDate, days: input.historyDays },
        votingTraces.slice(0, 1),
      ),
    );
  }

  return { sentences, disagreements };
}

/**
 * Every trace must resolve to a reading present for this date.
 *
 * Called by the persistence path and asserted by a test. A synthesis claim with
 * no supporting module reading is a bug, and this is where it is caught — before
 * anything reaches a user, rather than as a rendering oddity afterwards.
 */
export function assertTraceable(synthesis: Synthesis, readings: ModuleReading[]): void {
  const present = new Set(readings.map((r) => `${r.moduleCode}:${r.readingCode}`));
  const all = [...synthesis.sentences, ...synthesis.disagreements];
  for (const s of all) {
    if (s.traces.length === 0) {
      throw new Error(`Synthesis sentence "${s.templateId}" has no traces`);
    }
    for (const t of s.traces) {
      if (!present.has(`${t.moduleCode}:${t.readingCode}`)) {
        throw new Error(
          `Synthesis sentence "${s.templateId}" traces to ${t.moduleCode}:${t.readingCode}, ` +
            'which has no reading for this date',
        );
      }
    }
  }
}

export const MODULE_ORDER: ModuleCode[] = [
  'YIELDS',
  'VOL_CREDIT',
  'ECON_DATA',
  'DOLLAR_POSITIONING',
  'POLICY_STANCE',
];

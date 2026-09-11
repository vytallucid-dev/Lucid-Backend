import type { ColorBand } from '../compass-bands';
import { explanation } from './templates';
import type { ModuleCode, ModuleReading, ModuleState } from './module-types';

/**
 * Layer 1 — the five modules.
 *
 * Each is a PURE function from that module's readings to its state. No I/O, no
 * dates, no config lookups: given the same readings, always the same state.
 *
 * A module's verdict is computed ONLY from readings where `isVoting` is true.
 * Display readings — term premium, the hedged JGB pickup, the co-movement state —
 * cannot influence it. That separation is what makes it safe to add readings.
 *
 * `verdictBand` is NULLABLE, and Policy Stance uses that. It is a descriptive
 * module: it says what the anchors are, and inventing a green/yellow/red for it
 * would manufacture an opinion nothing in the evidence supports.
 */

function votingBands(readings: ModuleReading[]): ColorBand[] {
  return readings
    .filter((r) => r.isVoting && r.colorBand !== null)
    .map((r) => r.colorBand as ColorBand);
}

function worstOf(bands: ColorBand[]): ColorBand | null {
  if (bands.length === 0) return null;
  if (bands.includes('RED')) return 'RED';
  if (bands.includes('YELLOW')) return 'YELLOW';
  return 'GREEN';
}

function codes(readings: ModuleReading[]): string[] {
  return readings.map((r) => r.readingCode);
}

// --------------------------------------------------------------------- YIELDS
export function yieldsModule(readings: ModuleReading[]): ModuleState {
  const curve = readings.find((r) => r.readingCode === 'CURVE_2S10S');
  const r1 = readings.find((r) => r.readingCode === 'R1_REAL_YIELD_SHOCK');
  const verdict = worstOf(votingBands(readings));

  let headline = explanation('module.yields.calm');
  if (curve?.colorBand === 'RED') {
    headline = explanation('module.yields.curve_red');
  } else if (r1?.colorBand === 'RED' || r1?.colorBand === 'YELLOW') {
    headline = explanation('module.yields.real_shock', { bp: r1.valueNumeric });
  }

  return {
    moduleCode: 'YIELDS',
    verdictBand: verdict,
    stateLabel: null,
    headline,
    readingCodes: codes(readings),
  };
}

// ---------------------------------------------------------------- VOL_CREDIT
export function volCreditModule(readings: ModuleReading[]): ModuleState {
  const bands = votingBands(readings);
  const reds = bands.filter((b) => b === 'RED').length;
  const verdict = worstOf(bands);

  const headline =
    reds >= 2
      ? explanation('module.vol_credit.stressed', { redInputs: reds })
      : verdict === 'GREEN'
        ? explanation('module.vol_credit.calm')
        : explanation('module.vol_credit.mixed');

  return {
    moduleCode: 'VOL_CREDIT',
    verdictBand: verdict,
    stateLabel: null,
    headline,
    readingCodes: codes(readings),
  };
}

// ----------------------------------------------------------------- ECON_DATA
export function econDataModule(readings: ModuleReading[]): ModuleState {
  const verdict = worstOf(votingBands(readings));
  const headline =
    verdict === 'RED'
      ? explanation('module.econ.red')
      : verdict === 'GREEN'
        ? explanation('module.econ.green')
        : explanation('module.econ.yellow');

  return {
    moduleCode: 'ECON_DATA',
    verdictBand: verdict,
    stateLabel: null,
    headline,
    readingCodes: codes(readings),
  };
}

// -------------------------------------------------------- DOLLAR_POSITIONING
export function dollarModule(readings: ModuleReading[]): ModuleState {
  const verdict = worstOf(votingBands(readings));
  const corr = readings.find((r) => r.readingCode === 'DXY_YIELD_CORR');

  return {
    moduleCode: 'DOLLAR_POSITIONING',
    verdictBand: verdict,
    // A non-vote state label: the co-movement state describes the dollar's
    // relationship to yields without expressing a view on risk appetite. This is
    // the axis a future "repricing regime" reading would use.
    stateLabel: corr?.stateLabel ?? null,
    headline:
      verdict === 'RED'
        ? explanation('module.dollar.break')
        : explanation('module.dollar.calm'),
    readingCodes: codes(readings),
  };
}

// ------------------------------------------------------------- POLICY_STANCE
export function policyStanceModule(readings: ModuleReading[]): ModuleState {
  const rate = (code: string): number | null =>
    readings.find((r) => r.readingCode === code)?.valueNumeric ?? null;

  return {
    moduleCode: 'POLICY_STANCE',
    // NULL BY DESIGN. This module describes the policy anchors; it does not vote
    // and has no verdict. Phase B is explicit that policy rates are the anchor
    // for the yields reading, not a signal of their own.
    verdictBand: null,
    stateLabel: null,
    headline: explanation('module.policy.descriptive', {
      fed: rate('POLICY_RATE_US'),
      boj: rate('POLICY_RATE_JP'),
      ecb: rate('POLICY_RATE_XM'),
      // The differential is the point of the sentence, so it is computed once
      // here and passed in rather than being derived inside a template — a
      // template stays a pure format of the params it is handed.
      gap: (() => {
        const fed = rate('POLICY_RATE_US');
        const boj = rate('POLICY_RATE_JP');
        return fed !== null && boj !== null ? Math.round((fed - boj) * 100) / 100 : null;
      })(),
    }),
    readingCodes: codes(readings),
  };
}

const BUILDERS: Record<ModuleCode, (r: ModuleReading[]) => ModuleState> = {
  YIELDS: yieldsModule,
  VOL_CREDIT: volCreditModule,
  ECON_DATA: econDataModule,
  DOLLAR_POSITIONING: dollarModule,
  POLICY_STANCE: policyStanceModule,
};

export function buildModuleStates(readings: ModuleReading[]): ModuleState[] {
  return (Object.keys(BUILDERS) as ModuleCode[]).map((code) =>
    BUILDERS[code](readings.filter((r) => r.moduleCode === code)),
  );
}

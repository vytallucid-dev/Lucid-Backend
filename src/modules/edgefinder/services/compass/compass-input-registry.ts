import { ingestVixInput } from './inputs/vix-input.service';
import { ingestHyOasInput } from './inputs/hy-oas-input.service';
import { ingestYieldCurveInput } from './inputs/yield-curve-input.service';
import { ingestDxyTrendInput } from './inputs/dxy-trend-input.service';
import { ingestVixTermStructureInput } from './inputs/vix-term-structure-input.service';
import { ingestUsDataStackInput } from './inputs/us-data-stack-input.service';
import { ingestUsdJpyPriceInput } from './inputs/usdjpy-price-input.service';
import { ingestUs02yCloseInput } from './inputs/us02y-close-input.service';
import { ingestRealYieldShockInput } from './inputs/real-yield-shock-input.service';
import type { CompassConfigDefinition } from './compass-config.types';

/**
 * THE single registry of Compass ingest functions and their ordering.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * There used to be two hand-maintained lists — one in
 * compass-input-orchestrator.service.ts (the live cron) and one in
 * validation/historical-backfill.service.ts (the backfill) — that had to be kept
 * in sync by memory. Both encoded a load-bearing ordering constraint
 * (US_DATA_STACK before YIELD_2S10S) only as list position, with a runtime throw
 * as the safety net.
 *
 * Phase C adds a SECOND such edge (REAL_YIELD_SHOCK before YIELD_2S10S, because
 * the 2s10s GREEN clause is gated on R1's band), which would have meant three
 * places to get wrong. So the ordering is now declared as data via `dependsOn`
 * and the execution order is derived from it, once.
 */

export type IngestFn = (
  observationDate: Date,
  config: CompassConfigDefinition,
  isValidation?: boolean,
) => Promise<void>;

export interface InputDescriptor {
  code: string;
  fn: IngestFn;
  /**
   * Input codes whose compass_inputs row must already exist for this date
   * before this input runs. Each dependent input re-reads its dependency from
   * the database rather than trusting list order, and throws if it is missing —
   * so this ordering is an optimisation of a guarantee, not the guarantee.
   */
  dependsOn?: string[];
  /** False for plumbing rows that exist only to give another component history. */
  voting: boolean;
}

/**
 * Declared, unordered. `orderedCompassInputs()` resolves execution order.
 *
 * VOTING (six, weights summing to exactly 8.0):
 *   VIX_5D_AVG, VIX_TERM_STRUCTURE, HY_OAS, YIELD_2S10S, DXY_TREND, US_DATA_STACK
 *
 * NON-VOTING:
 *   USDJPY_PRICE     Shock Layer plumbing (Trigger B)
 *   US02Y_CLOSE      rate-gate plumbing (Phase 6)
 *   REAL_YIELD_SHOCK Phase C R1 — displayed, and gates the 2s10s GREEN clause,
 *                    but carries no weight and is not in EXPECTED_INPUT_CODES
 */
export const COMPASS_INPUTS: InputDescriptor[] = [
  { code: 'VIX_5D_AVG', fn: ingestVixInput, voting: true },
  { code: 'HY_OAS', fn: ingestHyOasInput, voting: true },
  { code: 'DXY_TREND', fn: ingestDxyTrendInput, voting: true },
  { code: 'VIX_TERM_STRUCTURE', fn: ingestVixTermStructureInput, voting: true },
  { code: 'US_DATA_STACK', fn: ingestUsDataStackInput, voting: true },
  { code: 'REAL_YIELD_SHOCK', fn: ingestRealYieldShockInput, voting: false },
  {
    code: 'YIELD_2S10S',
    fn: ingestYieldCurveInput,
    // Reads US_DATA_STACK's persisted jobs sub-check (Phase 2B) and
    // REAL_YIELD_SHOCK's persisted band (Phase C curve gate).
    dependsOn: ['US_DATA_STACK', 'REAL_YIELD_SHOCK'],
    voting: true,
  },
  {
    code: 'USDJPY_PRICE',
    fn: (date, _config, isValidation) => ingestUsdJpyPriceInput(date, isValidation),
    voting: false,
  },
  {
    code: 'US02Y_CLOSE',
    fn: (date, _config, isValidation) => ingestUs02yCloseInput(date, isValidation),
    voting: false,
  },
];

/**
 * Execution order: a stable topological sort over `dependsOn`. Stable so the
 * order stays predictable and diffable rather than shifting when an unrelated
 * input is added. Throws on a cycle or an unknown dependency rather than
 * silently producing an order that violates a constraint.
 */
export function orderedCompassInputs(
  inputs: InputDescriptor[] = COMPASS_INPUTS,
): InputDescriptor[] {
  const byCode = new Map(inputs.map((i) => [i.code, i]));
  const ordered: InputDescriptor[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (d: InputDescriptor, trail: string[]): void => {
    if (done.has(d.code)) return;
    if (visiting.has(d.code)) {
      throw new Error(`Compass input registry: dependency cycle ${[...trail, d.code].join(' -> ')}`);
    }
    visiting.add(d.code);
    for (const dep of d.dependsOn ?? []) {
      const target = byCode.get(dep);
      if (!target) {
        throw new Error(`Compass input registry: "${d.code}" depends on unknown input "${dep}"`);
      }
      visit(target, [...trail, d.code]);
    }
    visiting.delete(d.code);
    done.add(d.code);
    ordered.push(d);
  };

  for (const d of inputs) visit(d, []);
  return ordered;
}

/** Codes whose rows another input reads for the same date. */
export function dependencyCodes(inputs: InputDescriptor[] = COMPASS_INPUTS): string[] {
  return [...new Set(inputs.flatMap((i) => i.dependsOn ?? []))];
}

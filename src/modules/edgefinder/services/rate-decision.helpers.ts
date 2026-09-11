import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';

/**
 * Central-bank rate decisions.
 *
 * ── THEY USED TO BE THE ODD ONE OUT, AND NO LONGER ARE ──────────────────────
 * Every indicator in this system stores three LEVELS — actual, forecast,
 * previous — in the three DataPoint columns, and the difference between them is
 * computed where it is needed. CPI stores 3.4 / 3.4 / 3.5; unemployment stores
 * 4.1 / 4.1 / 4.1.
 *
 * Rate decisions used to be the single exception. Ingestion converted the
 * entered levels into a bps CHANGE against the previous decision, stored those
 * deltas in `value` and `forecastValue`, wrote `previousValue: null` because
 * there was no column left for the prior rate, and pushed the levels the admin
 * actually typed into `sourceMetadata.rate_level` / `.expected_rate_level`.
 *
 * The stated reason was that rate decisions are scored on SURPRISE rather than
 * on the absolute action, and that both columns had to be in the same unit for
 * the handler to diff them honestly. The first half is true and unchanged. The
 * second half did not require the conversion, because the baseline cancels:
 *
 *     (actual - prior) - (forecast - prior)  ==  actual - forecast
 *
 * So the conversion did no work for scoring, and cost a great deal:
 *
 *   - `previousValue` had to be nulled, losing the prior rate from the row.
 *   - The real numbers hid in metadata, so every display path needed to know
 *     the exception. The asset scorecard did not, and rendered every
 *     central-bank rate as "0.00% / 0.00% / 0.00%" for as long as it existed.
 *   - The edit path did not either, and wrote levels straight into a column the
 *     handler reads as basis points — corrupting the score silently.
 *   - A FIRST rate decision could never be scored even with a forecast on file,
 *     because converting the forecast needed a prior that did not exist yet.
 *     The surprise was knowable from the two levels the whole time.
 *
 * Rate decisions now store levels like everything else. The handler diffs them
 * and produces exactly the same score. What is left here is the small amount
 * that is genuinely specific to a rate decision.
 *
 * ── A COLLISION WORTH KNOWING ABOUT ─────────────────────────────────────────
 * `isRateDecisionCode` matches on the `_RATE` suffix, which is the convention
 * this codebase already used. It also matches `IND_NIFTY_04_RBI_RATE`, which is
 * NOT a rate decision: it is a NIFTY `cycle_regime` indicator, scored by a
 * different handler, and it has always stored levels. Nothing breaks today
 * because every caller of this predicate is on an EdgeFinder-only path — but
 * anything that reaches the database by this predicate alone would touch it.
 * Scope by the scoring rule (`rule_type = 'rate_decision'`) for that, never by
 * the code suffix. The migration script does exactly this.
 */
export function isRateDecisionCode(code: string): boolean {
  return code.endsWith('_RATE');
}

/**
 * The rate set at the most recent decision before `beforeDate`.
 *
 * Used by the ingestion paths to populate `previousValue`, so a row records the
 * rate it moved from. Reads `value`, which since the levels migration IS the
 * announced rate; it previously had to dig `rate_level` out of the metadata.
 *
 * Returns null when there is no earlier decision — a first release, where there
 * is genuinely no prior rate rather than a prior rate of zero.
 */
export async function getPriorRateLevel(
  indicatorId: string,
  beforeDate: Date,
): Promise<number | null> {
  const prior = await prisma.dataPoint.findFirst({
    where: {
      indicatorId,
      isCurrent: true,
      observationDate: { lt: beforeDate },
    },
    orderBy: { observationDate: 'desc' },
    select: { value: true },
  });

  if (!prior || prior.value === null) return null;
  const level = Number(prior.value);
  return Number.isFinite(level) ? level : null;
}

/**
 * The announced target range, when a central bank publishes one.
 *
 * ── WHY THIS IS A SEPARATE FIELD AND NOT A REUSE ────────────────────────────
 * EdgeFinder needs ONE announced number to diff against the previous decision
 * and the forecast — a range has no meaning in that arithmetic. Compass needs
 * the policy rate as a LEVEL, because that is the anchor a 2-year yield is
 * interpreted against. Those are different requirements, and folding them into
 * one field would force one of them to be wrong.
 *
 *   - The Fed publishes a target range (3.50-3.75%). Both bounds filled.
 *   - The BoE, BoJ and ECB publish a single rate. Both bounds null.
 *
 * ── WHAT BIS SUPPLIES, AND HOW THIS RELATES ─────────────────────────────────
 * Checked against the live series rather than assumed: BIS WS_CBPOL for the US
 * carries 3.625 — the MIDPOINT of the 3.50-3.75 target range, not either bound
 * and not effective fed funds. That is why Compass reads 3.63% while EdgeFinder
 * reads 3.75% (the upper bound) for the same bank on the same day. Two correct
 * numbers under two conventions.
 *
 * Still in `sourceMetadata`, because unlike the three levels there is no column
 * for it and no scoring use — it is display and reconciliation only.
 */
export interface RateRange {
  lower: number | null;
  upper: number | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

export function rateRangeFromMetadata(sourceMetadata: unknown): RateRange {
  const meta = (sourceMetadata ?? {}) as Record<string, unknown>;
  return { lower: num(meta.rate_range_lower), upper: num(meta.rate_range_upper) };
}

/** The midpoint BIS publishes for a banded target, or null when there is no band. */
export function rateRangeMidpoint(range: RateRange): number | null {
  if (range.lower === null || range.upper === null) return null;
  return Math.round(((range.lower + range.upper) / 2) * 1e6) / 1e6;
}

/**
 * Merges the range bounds into a row's existing metadata.
 *
 * `undefined` leaves whatever is stored alone; an explicit `null` clears it.
 * Shared by the entry and edit paths so the two cannot disagree about what an
 * omitted bound means.
 */
export function withRateRange(
  existing: Prisma.InputJsonObject,
  lower: number | null | undefined,
  upper: number | null | undefined,
): Prisma.InputJsonObject {
  return {
    ...existing,
    ...(lower !== undefined ? { rate_range_lower: lower } : {}),
    ...(upper !== undefined ? { rate_range_upper: upper } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade-entry validation rules, and the integrity check derived from them.
//
// Every rule lives here as a pure function returning a field-anchored problem
// (or null), so the same rule and the same wording are used by the Zod schemas
// at the route boundary, by the service checks that need to see both a trade
// and its executions, and by the integrity check that decides whether a stored
// trade needs attention. A rule says what is wrong and shows the offending
// values — "Stop loss must be below entry for a Buy — entry 1.0865, stop
// 1.0905", not "invalid stop".
//
// ── SEVERITY AND PATH ───────────────────────────────────────────────────────
//
// Validation that prevents fixing bad data is worse than no validation. A
// trade whose exit year was typed as 2025 instead of 2026 cannot be corrected
// if the correction itself is refused — fixing it requires saving it, and
// saving it is what gets refused. That circularity decides the whole design.
//
// Each rule therefore carries a severity, and the write path decides what a
// failure means:
//
//   severity 'blocking'  — the row cannot be stored on ANY path. Reserved for
//                          failures that make the row impossible to interpret
//                          rather than merely wrong: a zero-risk stop (R is
//                          undefined, not incorrect), a closed fill with no
//                          exit price (nothing to resolve it against), a date
//                          that will not parse (nothing to store).
//
//   severity 'advisory'  — refuses a CREATE, because a hand-entered trade
//                          should be right the first time; but on an EDIT or
//                          an IMPORT it is recorded as a flag on the row
//                          instead. The trade saves, carries a visible
//                          needs-attention marker naming exactly what is
//                          wrong, and is excluded from every edge statistic
//                          until it is fixed.
//
// There is no per-path list of rules anywhere — the path is one argument and
// the severity is one field, so a rule added later is handled without editing
// any dispatch table.
//
// The rules are stated in terms of the plan, not the instrument: side-of-entry
// is decided by direction alone, so a new pair needs no entry here. Nothing in
// this file reads pips, points or R magnitude, which is deliberate — a bound
// written against 4-decimal forex would flag every index trade now that
// instrument-scale.ts quotes indices and metals in whole points.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a failure stops the write everywhere, or only on create. */
export type ProblemSeverity = 'blocking' | 'advisory';

/** How a row is being written. Import behaves exactly as an edit: a messy
 * import must be able to land and be corrected afterwards, rather than being
 * rejected wholesale. No importer exists yet; this is the seam it will use. */
export type WritePath = 'create' | 'edit' | 'import';

/** A validation failure, anchored to the field the user has to fix. */
export interface FieldProblem {
  /** Field path, matching the API's snake_case body shape. */
  field: string;
  message: string;
  severity: ProblemSeverity;
}

/**
 * Does this failure refuse the write on this path?
 *
 * Blocking always refuses. Advisory refuses a create and flags anything else.
 */
export function blocksWrite(problem: FieldProblem, path: WritePath): boolean {
  return problem.severity === 'blocking' || path === 'create';
}

/** The subset of `problems` that refuses a write on `path`. */
export function blockingProblems(problems: FieldProblem[], path: WritePath): FieldProblem[] {
  return problems.filter((p) => blocksWrite(p, path));
}

/** Risk sits inside this band or the entry is a typo (25 for 2.5, 100 for 1.00). */
export const RISK_PCT_MIN = 0.01;
export const RISK_PCT_MAX = 10;

/** Clock-skew grace on "not in the future" checks. */
const FUTURE_GRACE_MS = 60_000;

function price(n: number): string {
  return String(n);
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/**
 * A date that actually parsed.
 *
 * The date rules are handed `new Date(someString)`, which yields an Invalid
 * Date for junk input rather than throwing. Formatting one throws a RangeError,
 * which surfaced as a 500 instead of the 400 the caller deserves. An
 * unparseable date is reported by the schema's own `dateTimeLike` refine — it
 * is blocking on every path and needs no second opinion here — so these rules
 * simply decline to judge it.
 */
function isRealDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function blocking(field: string, message: string): FieldProblem {
  return { field, message, severity: 'blocking' };
}

function advisory(field: string, message: string): FieldProblem {
  return { field, message, severity: 'advisory' };
}

/**
 * Stop must sit on the losing side of entry: below for a Buy, above for a Sell.
 *
 * Two distinct failures with two different severities, which is why they are
 * returned separately. A stop ON entry is zero risk, so R is a division by
 * zero — undefined, and the row cannot be interpreted: blocking. A stop on the
 * WRONG side computes perfectly well and simply carries the wrong sign — a
 * wrong number, correctable in place: advisory.
 */
export function checkStopSide(
  direction: string,
  entryPrice: number,
  slPrice: number,
): FieldProblem | null {
  const isBuy = direction === 'Buy';
  if (isBuy && slPrice < entryPrice) return null;
  if (!isBuy && slPrice > entryPrice) return null;
  if (slPrice === entryPrice) {
    return blocking(
      'planned_sl',
      `Stop loss cannot equal the entry price — that is zero risk, so R is undefined. Entry and stop are both ${price(entryPrice)}.`,
    );
  }
  return advisory(
    'planned_sl',
    isBuy
      ? `Stop loss must be below the entry price for a Buy — entry ${price(entryPrice)}, stop ${price(slPrice)}. Did you mean this to be a Sell?`
      : `Stop loss must be above the entry price for a Sell — entry ${price(entryPrice)}, stop ${price(slPrice)}. Did you mean this to be a Buy?`,
  );
}

/**
 * Target must sit on the winning side of entry: above for a Buy, below for a
 * Sell. Advisory in both shapes — a target on entry gives an expected R of 0
 * and a target on the wrong side gives a negative one. Both are wrong numbers,
 * neither is an impossible one.
 */
export function checkTargetSide(
  direction: string,
  entryPrice: number,
  targetPrice: number,
  field: 'planned_main_tp' | 'planned_first_tp',
  label: string,
): FieldProblem | null {
  const isBuy = direction === 'Buy';
  if (isBuy && targetPrice > entryPrice) return null;
  if (!isBuy && targetPrice < entryPrice) return null;
  if (targetPrice === entryPrice) {
    return advisory(
      field,
      `${label} cannot equal the entry price — there is no reward to target. Entry and target are both ${price(entryPrice)}.`,
    );
  }
  return advisory(
    field,
    isBuy
      ? `${label} must be above the entry price for a Buy — entry ${price(entryPrice)}, target ${price(targetPrice)}. Did you mean this to be a Sell?`
      : `${label} must be below the entry price for a Sell — entry ${price(entryPrice)}, target ${price(targetPrice)}. Did you mean this to be a Buy?`,
  );
}

/** The first target is taken on the way to the main one, so it cannot sit beyond it. */
export function checkFirstTpOrder(
  direction: string,
  firstTp: number,
  mainTp: number,
): FieldProblem | null {
  const isBuy = direction === 'Buy';
  const beyond = isBuy ? firstTp > mainTp : firstTp < mainTp;
  if (!beyond) return null;
  return advisory(
    'planned_first_tp',
    `First TP must come before the main TP — first TP ${price(firstTp)} is ${isBuy ? 'above' : 'below'} the main TP ${price(mainTp)}. Swap them, or clear the first TP.`,
  );
}

/** A trade cannot be opened in the future. A real date, merely implausible. */
export function checkEntryNotFuture(dateOpened: Date, now = new Date()): FieldProblem | null {
  if (!isRealDate(dateOpened)) return null;
  if (dateOpened.getTime() <= now.getTime() + FUTURE_GRACE_MS) return null;
  return advisory(
    'date_opened',
    `Entry date cannot be in the future — you entered ${stamp(dateOpened)}, and it is now ${stamp(now)}. Log it in Planned Trades until it fills.`,
  );
}

/** Nor closed in the future. */
export function checkExitNotFuture(
  dateClosed: Date,
  now = new Date(),
  field = 'date_closed',
): FieldProblem | null {
  if (!isRealDate(dateClosed)) return null;
  if (dateClosed.getTime() <= now.getTime() + FUTURE_GRACE_MS) return null;
  return advisory(
    field,
    `Exit date cannot be in the future — you entered ${stamp(dateClosed)}, and it is now ${stamp(now)}.`,
  );
}

/**
 * A trade cannot close before it opened.
 *
 * Advisory, and this is the rule the whole tier design is built around: the one
 * real case is an exit year typed as 2025 instead of 2026. Correcting a single
 * digit requires saving the row, so blocking the save makes the mistake
 * permanent. Hold time goes negative, which is a wrong number — the trade is
 * still entirely interpretable.
 */
export function checkExitAfterEntry(
  dateOpened: Date,
  dateClosed: Date,
  field = 'date_closed',
): FieldProblem | null {
  if (!isRealDate(dateOpened) || !isRealDate(dateClosed)) return null;
  if (dateClosed.getTime() >= dateOpened.getTime()) return null;
  return advisory(
    field,
    `Exit date cannot be before the entry date — opened ${stamp(dateOpened)}, closed ${stamp(dateClosed)}.`,
  );
}

/**
 * Closing a trade requires the price it closed at. Blocking: with no exit
 * price there are no pips, no R and no win/loss — the fill cannot be resolved
 * at all, on any path.
 */
export function checkExitPricePresent(
  isClosed: boolean,
  mainExitPrice: number | null | undefined,
  field = 'main_exit_price',
): FieldProblem | null {
  if (!isClosed || mainExitPrice != null) return null;
  return blocking(
    field,
    'Exit price is required to mark this account closed — enter the price it actually exited at, or switch the trade back to open.',
  );
}

/**
 * Risk outside a sane band is a typo far more often than a real position.
 * Advisory: risk_pct feeds no statistic — it cancels out of R entirely — so a
 * bad value misreports position sizing without corrupting any number.
 */
export function checkRiskBand(riskPct: number, field = 'risk_pct'): FieldProblem | null {
  if (riskPct >= RISK_PCT_MIN && riskPct <= RISK_PCT_MAX) return null;
  return advisory(
    field,
    riskPct < RISK_PCT_MIN
      ? `Risk % must be at least ${RISK_PCT_MIN} — you entered ${riskPct}. A trade risking nothing has no R to measure.`
      : `Risk % must be at most ${RISK_PCT_MAX} — you entered ${riskPct}. If you meant ${riskPct / 10}%, drop a digit.`,
  );
}

/** A partial exit needs both halves: the price it went off at, and how much. */
export function checkPartialCoherence(
  partialExitPrice: number | null | undefined,
  partialExitLotPct: number | null | undefined,
): FieldProblem | null {
  const hasPrice = partialExitPrice != null;
  const hasPct = partialExitLotPct != null;
  if (hasPrice === hasPct) return null;
  return hasPrice
    ? advisory(
        'partial_exit_lot_pct',
        `Partial exit price ${price(partialExitPrice as number)} needs a partial lot % — how much of the position came off there.`,
      )
    : advisory(
        'partial_exit_price',
        `Partial lot ${partialExitLotPct}% needs a partial exit price — the price that portion came off at.`,
      );
}

/**
 * Every plan-level rule for one idea, in field order. Used by the create
 * schema, re-run in the service on update against the merged values, and run
 * again by the integrity check against what is stored.
 */
export function checkPlan(input: {
  direction: string;
  plannedEntry: number;
  plannedSl: number;
  plannedFirstTp: number | null;
  plannedMainTp: number;
  dateOpened: Date | null;
}, now = new Date()): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const push = (p: FieldProblem | null): void => { if (p) problems.push(p); };

  push(checkStopSide(input.direction, input.plannedEntry, input.plannedSl));
  push(checkTargetSide(input.direction, input.plannedEntry, input.plannedMainTp, 'planned_main_tp', 'Main TP'));
  if (input.plannedFirstTp != null) {
    const side = checkTargetSide(input.direction, input.plannedEntry, input.plannedFirstTp, 'planned_first_tp', 'First TP');
    push(side);
    if (!side) push(checkFirstTpOrder(input.direction, input.plannedFirstTp, input.plannedMainTp));
  }
  if (isRealDate(input.dateOpened)) push(checkEntryNotFuture(input.dateOpened, now));

  return problems;
}

/**
 * Every fill-level rule for one execution. `dateOpened` is the parent idea's
 * entry instant — the exit-ordering rule is the one check that cannot be made
 * from the execution body alone.
 */
export function checkExecution(input: {
  riskPct: number;
  isClosed: boolean;
  mainExitPrice: number | null;
  partialExitPrice: number | null;
  partialExitLotPct: number | null;
  dateClosed: Date | null;
  dateOpened: Date | null;
}, now = new Date()): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const push = (p: FieldProblem | null): void => { if (p) problems.push(p); };

  push(checkRiskBand(input.riskPct));
  push(checkExitPricePresent(input.isClosed, input.mainExitPrice));
  push(checkPartialCoherence(input.partialExitPrice, input.partialExitLotPct));
  if (isRealDate(input.dateClosed)) {
    push(checkExitNotFuture(input.dateClosed, now));
    if (isRealDate(input.dateOpened)) push(checkExitAfterEntry(input.dateOpened, input.dateClosed));
  }

  return problems;
}

// ─── The integrity check ─────────────────────────────────────────────────────
//
// THE one implementation. Computed on read from the stored row, never stored
// itself, and serialized onto the DTO so every surface — the journal table, the
// drawer, the filter, every statistic — reads the same answer rather than
// re-deriving it. Nothing recomputes this client-side.
//
// Because it is derived, there is no state to drift and no "resolve" action to
// take: correcting the offending field makes the next read come back clean.

/** One integrity failure, with the execution it belongs to when it is fill-level. */
export interface IntegrityProblem extends FieldProblem {
  /** The execution this failure belongs to, or null for an idea-level failure. */
  executionId: string | null;
}

export interface TradeIntegrity {
  /** False ⇒ this trade needs attention and is excluded from edge statistics. */
  ok: boolean;
  problems: IntegrityProblem[];
}

/**
 * Re-runs every rule against a stored trade and its fills.
 *
 * Severity is reported but not filtered on: a stored row can normally only
 * carry advisory failures, since blocking ones are refused on every write path,
 * but a row that predates a rule — or that a future importer lands — may carry
 * either, and both need surfacing.
 *
 * `dateOpened`/`dateClosed` are already `Date`s here; a value that could not
 * parse never reached the column.
 */
export function checkTradeIntegrity(
  trade: {
    direction: string;
    plannedEntry: number;
    plannedSl: number;
    plannedFirstTp: number | null;
    plannedMainTp: number;
    dateOpened: Date;
  },
  executions: Array<{
    id: string;
    riskPct: number;
    mainExitPrice: number | null;
    partialExitPrice: number | null;
    partialExitLotPct: number | null;
    dateClosed: Date | null;
  }>,
  now = new Date(),
): TradeIntegrity {
  const problems: IntegrityProblem[] = checkPlan(
    {
      direction: trade.direction,
      plannedEntry: trade.plannedEntry,
      plannedSl: trade.plannedSl,
      plannedFirstTp: trade.plannedFirstTp,
      plannedMainTp: trade.plannedMainTp,
      dateOpened: trade.dateOpened,
    },
    now,
  ).map((p) => ({ ...p, executionId: null }));

  for (const e of executions) {
    const fill = checkExecution(
      {
        riskPct: e.riskPct,
        isClosed: e.dateClosed != null,
        mainExitPrice: e.mainExitPrice,
        partialExitPrice: e.partialExitPrice,
        partialExitLotPct: e.partialExitLotPct,
        dateClosed: e.dateClosed,
        dateOpened: trade.dateOpened,
      },
      now,
    );
    for (const p of fill) problems.push({ ...p, executionId: e.id });
  }

  return { ok: problems.length === 0, problems };
}

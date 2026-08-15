import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { toTradeDto, type TradeDto, type TradeWithExecutions } from './serialize';
import { computeTradeMetrics, sessionFromDate, type TradeMetrics } from './trade-metrics';
import { sameScoreDate, snapshotOracleScore, type OracleScoreSource } from './oracle-snapshot';
import {
  blockingProblems,
  checkExecution,
  checkPlan,
  type FieldProblem,
  type WritePath,
} from './trade-validation';
import { isForexPairSymbol } from './instrument-scale';
import type {
  CreateTradeInput,
  UpdateTradeInput,
  CreateExecutionInput,
  UpdateExecutionInput,
} from '../types/trading.types';

const includeExecutions = { executions: true } as const;

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

function decOrNull(n: number | null | undefined): Prisma.Decimal | null {
  return n == null ? null : new Prisma.Decimal(n);
}

/**
 * Refuses the write if any problem blocks it ON THIS PATH.
 *
 * On `create`, everything blocks — a hand-entered trade should be right the
 * first time. On `edit` and `import`, only genuinely blocking failures refuse;
 * the rest are allowed through and resurface as integrity flags on the stored
 * row, which is what makes an already-wrong trade correctable at all.
 *
 * The full blocking list travels in `details` so a client can anchor every
 * message at once; the thrown message names the first so the error stays
 * specific even where details are stripped.
 */
function assertWritable(problems: FieldProblem[], path: WritePath): void {
  const blocked = blockingProblems(problems, path);
  if (blocked.length === 0) return;
  throw new AppError(400, blocked[0].message, 'VALIDATION_ERROR', { problems: blocked });
}

async function assertAccountOwned(userId: string, accountId: string): Promise<void> {
  const account = await prisma.tradingAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!account) {
    throw new AppError(400, 'Account not found for this user', 'ACCOUNT_NOT_FOUND');
  }
}

/** Loads a trade (idea) with its executions, or throws 404. Scoped to the owning user. */
async function loadOwnedTrade(userId: string, id: string): Promise<TradeWithExecutions> {
  const trade = await prisma.trade.findFirst({ where: { id, userId }, include: includeExecutions });
  if (!trade) throw new AppError(404, 'Trade not found', 'TRADE_NOT_FOUND');
  return trade;
}

async function loadOwnedExecution(
  userId: string,
  tradeId: string,
  executionId: string,
): Promise<{ trade: TradeWithExecutions; execution: TradeWithExecutions['executions'][number] }> {
  const trade = await loadOwnedTrade(userId, tradeId);
  const execution = trade.executions.find((e) => e.id === executionId);
  if (!execution) throw new AppError(404, 'Execution not found', 'EXECUTION_NOT_FOUND');
  return { trade, execution };
}

/**
 * Derives an execution's totalPips/blendedRr. Risk is measured against the
 * *idea's* stop (trade.plannedSl) — the invalidation level is shared across
 * accounts — while the distance is measured from this execution's own actual
 * entry and exit. blendedRr reduces to totalPips / riskPips (pip value and lot
 * size cancel), which is what makes R comparable across accounts of different
 * sizes and therefore the right unit for edge statistics.
 *
 * The distance unit follows the instrument: pips for forex, whole points for
 * indices and metals. Resolved from the asset registry, which is cached
 * in-process, so this stays a cheap lookup rather than a per-write query.
 *
 * P&L is deliberately absent: it is entered by hand, never derived from prices.
 */
async function computeExecutionMetrics(
  pair: string,
  plannedSl: number,
  execEntryPrice: number,
  direction: 'Buy' | 'Sell',
  isClosed: boolean,
  mainExitPrice: number | null | undefined,
  partialExitPrice: number | null | undefined,
  partialExitLotPct: number | null | undefined,
): Promise<TradeMetrics> {
  return computeTradeMetrics({
    direction,
    symbol: pair,
    isForexPair: await isForexPairSymbol(pair),
    entryPrice: execEntryPrice,
    slPrice: plannedSl,
    mainExitPrice: isClosed ? (mainExitPrice ?? null) : null,
    partialExitPrice: partialExitPrice ?? null,
    partialExitLotPct: partialExitLotPct ?? null,
  });
}

// ─── Oracle snapshot columns ────────────────────────────────────────────────
//
// Written once, keyed to a date, never recomputed. Re-reading a trade never
// changes them; only a change to the date the snapshot is addressed to (or to
// the pair it is addressed for) takes a fresh one. That is the whole point: a
// later revision to the Oracle's history must not silently rewrite the context
// a past trade was taken in.

interface EntrySnapshotColumns {
  oracleScoreAtEntry: number | null;
  oracleScoreEntryDate: Date | null;
  oracleScoreEntryCapturedAt: Date | null;
  oracleScoreEntrySource: OracleScoreSource | null;
}

interface ExitSnapshotColumns {
  oracleScoreAtExit: number | null;
  oracleScoreExitDate: Date | null;
  oracleScoreExitCapturedAt: Date | null;
}

/** A user-supplied score, stored verbatim. Null means "no score for this trade". */
function manualEntrySnapshot(score: number | null): EntrySnapshotColumns {
  return score == null
    ? {
        oracleScoreAtEntry: null,
        oracleScoreEntryDate: null,
        oracleScoreEntryCapturedAt: null,
        oracleScoreEntrySource: null,
      }
    : {
        oracleScoreAtEntry: score,
        oracleScoreEntryDate: null, // a hand-entered score is addressed to no date
        oracleScoreEntryCapturedAt: new Date(),
        oracleScoreEntrySource: 'manual',
      };
}

/** Reads the Oracle for `pair` on `dateOpened` and freezes the result. */
async function takeEntrySnapshot(pair: string, dateOpened: Date): Promise<EntrySnapshotColumns> {
  const snap = await snapshotOracleScore(pair, dateOpened);
  return {
    oracleScoreAtEntry: snap.score,
    // The date is recorded even when no score was found, so the UI can say
    // which day came up empty rather than leaving it ambiguous.
    oracleScoreEntryDate: snap.date,
    oracleScoreEntryCapturedAt: snap.capturedAt,
    oracleScoreEntrySource: snap.score == null ? null : 'snapshot',
  };
}

async function takeExitSnapshot(pair: string, dateClosed: Date): Promise<ExitSnapshotColumns> {
  const snap = await snapshotOracleScore(pair, dateClosed);
  return {
    oracleScoreAtExit: snap.score,
    oracleScoreExitDate: snap.date,
    oracleScoreExitCapturedAt: snap.capturedAt,
  };
}

const CLEARED_EXIT_SNAPSHOT: ExitSnapshotColumns = {
  oracleScoreAtExit: null,
  oracleScoreExitDate: null,
  oracleScoreExitCapturedAt: null,
};

/**
 * The exit snapshot for an execution being written.
 *
 * Re-snapshots only when the fact it describes changes — a different exit date,
 * a different pair, or no snapshot taken yet. An unchanged exit date keeps the
 * stored value untouched even if the Oracle has since revised that day.
 */
async function resolveExitSnapshot(
  pair: string,
  effectiveClosed: boolean,
  dateClosed: Date | null,
  existing: {
    oracleScoreExitDate: Date | null;
    oracleScoreAtExit: number | null;
    oracleScoreExitCapturedAt: Date | null;
  } | null,
  pairChanged: boolean,
): Promise<ExitSnapshotColumns> {
  if (!effectiveClosed || !dateClosed) return CLEARED_EXIT_SNAPSHOT;
  const alreadySnapshotted = existing?.oracleScoreExitCapturedAt != null;
  if (alreadySnapshotted && !pairChanged && sameScoreDate(existing.oracleScoreExitDate, dateClosed)) {
    return {
      oracleScoreAtExit: existing.oracleScoreAtExit,
      oracleScoreExitDate: existing.oracleScoreExitDate,
      oracleScoreExitCapturedAt: existing.oracleScoreExitCapturedAt,
    };
  }
  return takeExitSnapshot(pair, dateClosed);
}

// ─── Trades (ideas) ──────────────────────────────────────────────────────────

/**
 * Lists a user's ideas. When accountId is given, only ideas that have at
 * least one execution in that account are returned, and each returned idea's
 * `executions` array is filtered down to that account's execution(s) only —
 * "show me account X" means "X's fills", not every account the idea also ran
 * in.
 */
export async function listTrades(userId: string, accountId?: string): Promise<TradeDto[]> {
  const trades = await prisma.trade.findMany({
    where: {
      userId,
      ...(accountId ? { executions: { some: { accountId } } } : {}),
    },
    include: includeExecutions,
    orderBy: { dateOpened: 'desc' },
  });
  if (!accountId) return trades.map((t) => toTradeDto(t));
  // The narrowed view still reports the idea's integrity over ALL its fills —
  // a flag must not disappear because the offending fill belongs to another
  // account.
  return trades.map((t) =>
    toTradeDto(
      { ...t, executions: t.executions.filter((e) => e.accountId === accountId) },
      t.executions,
    ),
  );
}

export async function getTrade(userId: string, id: string): Promise<TradeDto> {
  return toTradeDto(await loadOwnedTrade(userId, id));
}

export async function createTrade(userId: string, input: CreateTradeInput): Promise<TradeDto> {
  for (const ex of input.executions) {
    await assertAccountOwned(userId, ex.account_id);
  }

  const dateOpened = input.date_opened ? new Date(input.date_opened) : new Date();
  const session = sessionFromDate(dateOpened);

  const markedPrimaryIdx = input.executions.findIndex((e) => e.is_primary);
  const primaryIdx = markedPrimaryIdx >= 0 ? markedPrimaryIdx : 0;

  // Omitting oracle_score_at_entry asks the server to snapshot; sending it
  // (including as null) is an explicit override, stored verbatim.
  const entrySnapshot =
    input.oracle_score_at_entry !== undefined
      ? manualEntrySnapshot(input.oracle_score_at_entry)
      : await takeEntrySnapshot(input.pair, dateOpened);

  const executionRows = await Promise.all(
    input.executions.map(async (ex, idx) => {
      const isClosed = ex.is_closed && ex.main_exit_price != null;
      const metrics = await computeExecutionMetrics(
        input.pair,
        input.planned_sl,
        ex.entry_price,
        input.direction,
        isClosed,
        ex.main_exit_price,
        ex.partial_exit_price,
        ex.partial_exit_lot_pct,
      );
      const dateClosed = isClosed ? (ex.date_closed ? new Date(ex.date_closed) : new Date()) : null;
      const exitSnapshot = isClosed && dateClosed
        ? await takeExitSnapshot(input.pair, dateClosed)
        : CLEARED_EXIT_SNAPSHOT;
      return {
        accountId: ex.account_id,
        isPrimary: idx === primaryIdx,
        riskPct: dec(ex.risk_pct),
        lotSize: dec(ex.lot_size),
        entryPrice: dec(ex.entry_price),
        partialExitPrice: isClosed ? decOrNull(ex.partial_exit_price) : null,
        partialExitLotPct: isClosed ? decOrNull(ex.partial_exit_lot_pct) : null,
        mainExitPrice: isClosed ? decOrNull(ex.main_exit_price) : null,
        exitType: ex.exit_type,
        dateClosed,
        totalPips: dec(metrics.totalPips),
        // Realised P&L is whatever the user typed. Not closed, or closed with
        // no figure entered yet → 0. Never derived from prices.
        blendedPnl: dec(isClosed ? (ex.net_pnl ?? 0) : 0),
        blendedRr: dec(metrics.blendedRr),
        ...exitSnapshot,
      };
    }),
  );

  const created = await prisma.$transaction(async (tx) => {
    const trade = await tx.trade.create({
      data: {
        userId,
        model: input.model,
        pair: input.pair,
        direction: input.direction,
        plannedEntry: dec(input.planned_entry),
        plannedSl: dec(input.planned_sl),
        plannedFirstTp: decOrNull(input.planned_first_tp),
        plannedMainTp: dec(input.planned_main_tp),
        conviction: input.conviction,
        dateOpened,
        session,
        screenshots: input.screenshots ?? [],
        psychology: input.psychology ?? null,
        notes: input.notes ?? null,
        ...entrySnapshot,
      },
    });
    await tx.execution.createMany({
      data: executionRows.map((row) => ({ ...row, tradeId: trade.id })),
    });
    return tx.trade.findUniqueOrThrow({ where: { id: trade.id }, include: includeExecutions });
  });

  return toTradeDto(created);
}

export async function updateTrade(
  userId: string,
  id: string,
  input: UpdateTradeInput,
): Promise<TradeDto> {
  const existing = await loadOwnedTrade(userId, id);

  const pair = input.pair ?? existing.pair;
  const direction = (input.direction ?? existing.direction) as 'Buy' | 'Sell';
  const plannedEntry = input.planned_entry ?? existing.plannedEntry.toNumber();
  const plannedSl = input.planned_sl ?? existing.plannedSl.toNumber();
  const plannedMainTp = input.planned_main_tp ?? existing.plannedMainTp.toNumber();
  const plannedFirstTp =
    input.planned_first_tp !== undefined
      ? input.planned_first_tp
      : existing.plannedFirstTp
        ? existing.plannedFirstTp.toNumber()
        : null;
  const dateOpened = input.date_opened ? new Date(input.date_opened) : existing.dateOpened;

  // A patch touches a few fields, but the rules are about the whole plan — so
  // they run against the merged result, not the patch in isolation. Otherwise
  // flipping direction alone would leave a stop on the wrong side unchallenged.
  assertWritable(
    checkPlan({ direction, plannedEntry, plannedSl, plannedFirstTp, plannedMainTp, dateOpened }),
    'edit',
  );
  // Moving the entry date forwards can strand an already-recorded exit behind it.
  assertWritable(
    existing.executions.flatMap((ex) =>
      checkExecution({
        riskPct: ex.riskPct.toNumber(),
        isClosed: ex.dateClosed != null,
        mainExitPrice: ex.mainExitPrice ? ex.mainExitPrice.toNumber() : null,
        partialExitPrice: ex.partialExitPrice ? ex.partialExitPrice.toNumber() : null,
        partialExitLotPct: ex.partialExitLotPct ? ex.partialExitLotPct.toNumber() : null,
        dateClosed: ex.dateClosed,
        dateOpened,
      }).filter((p) => p.field === 'date_closed'),
    ),
    'edit',
  );

  const pairChanged = input.pair !== undefined && input.pair !== existing.pair;
  const dateOpenedChanged = !sameScoreDate(existing.dateOpened, dateOpened);

  // Pair, planned stop and direction feed every execution's pip-multiplier,
  // risk distance and sign. If any changes, pips and R:R for every execution
  // are recomputed from that execution's own stored prices. P&L never moves —
  // it is the user's number, and only the user changes it.
  const metricsAffectingFieldsChanged =
    pairChanged ||
    (input.planned_sl !== undefined && input.planned_sl !== existing.plannedSl.toNumber()) ||
    (input.direction !== undefined && input.direction !== existing.direction);

  const data: Prisma.TradeUpdateInput = {
    model: input.model ?? existing.model,
    pair,
    direction,
    plannedSl: dec(plannedSl),
    dateOpened,
    session: sessionFromDate(dateOpened),
    conviction: input.conviction ?? existing.conviction,
  };
  if (input.planned_entry !== undefined) data.plannedEntry = dec(input.planned_entry);
  if (input.planned_first_tp !== undefined) data.plannedFirstTp = decOrNull(input.planned_first_tp);
  if (input.planned_main_tp !== undefined) data.plannedMainTp = dec(input.planned_main_tp);
  if (input.psychology !== undefined) data.psychology = input.psychology;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.screenshots !== undefined) data.screenshots = input.screenshots;

  // Entry snapshot. Order matters:
  //   an explicit, *changed* score is the user overriding — it wins outright;
  //   an explicit score equal to what is stored is an untouched edit form
  //     being re-saved, and must not rewrite provenance;
  //   otherwise a changed entry date or pair means the snapshot now addresses
  //     a different fact, so a fresh one is taken;
  //   otherwise nothing is written and the stored snapshot stands.
  const overrideSent = input.oracle_score_at_entry !== undefined;
  const overrideDiffers =
    overrideSent && (input.oracle_score_at_entry ?? null) !== existing.oracleScoreAtEntry;
  if (overrideDiffers) {
    Object.assign(data, manualEntrySnapshot(input.oracle_score_at_entry ?? null));
  } else if (dateOpenedChanged || pairChanged) {
    Object.assign(data, await takeEntrySnapshot(pair, dateOpened));
  }

  const updated = await prisma.$transaction(async (tx) => {
    const trade = await tx.trade.update({ where: { id }, data });

    if (metricsAffectingFieldsChanged) {
      for (const ex of existing.executions) {
        const isClosed = ex.dateClosed != null && ex.mainExitPrice != null;
        const metrics = await computeExecutionMetrics(
          pair,
          plannedSl,
          ex.entryPrice.toNumber(),
          direction,
          isClosed,
          ex.mainExitPrice ? ex.mainExitPrice.toNumber() : null,
          ex.partialExitPrice ? ex.partialExitPrice.toNumber() : null,
          ex.partialExitLotPct ? ex.partialExitLotPct.toNumber() : null,
        );
        // The exit snapshot is addressed to a pair as well as a date, so a
        // pair change re-takes it; a stop or direction change does not.
        const exitSnapshot = await resolveExitSnapshot(
          pair,
          isClosed,
          ex.dateClosed,
          ex,
          pairChanged,
        );
        await tx.execution.update({
          where: { id: ex.id },
          data: {
            totalPips: dec(metrics.totalPips),
            blendedRr: dec(metrics.blendedRr),
            ...exitSnapshot,
          },
        });
      }
    }

    return tx.trade.findUniqueOrThrow({ where: { id: trade.id }, include: includeExecutions });
  });

  return toTradeDto(updated);
}

export async function deleteTrade(userId: string, id: string): Promise<void> {
  await loadOwnedTrade(userId, id);
  await prisma.trade.delete({ where: { id } }); // executions cascade via FK
}

// ─── Executions (fills, per account) ────────────────────────────────────────

export async function addExecution(
  userId: string,
  tradeId: string,
  input: CreateExecutionInput,
): Promise<TradeDto> {
  const trade = await loadOwnedTrade(userId, tradeId);
  await assertAccountOwned(userId, input.account_id);

  const isClosed = input.is_closed && input.main_exit_price != null;
  const dateClosed = isClosed ? (input.date_closed ? new Date(input.date_closed) : new Date()) : null;

  // The one rule a standalone execution body cannot judge for itself. Adding a
  // fill is hand entry, so it is held to create-strictness like any other.
  assertWritable(
    checkExecution({
      riskPct: input.risk_pct,
      isClosed: input.is_closed,
      mainExitPrice: input.main_exit_price ?? null,
      partialExitPrice: input.partial_exit_price ?? null,
      partialExitLotPct: input.partial_exit_lot_pct ?? null,
      dateClosed,
      dateOpened: trade.dateOpened,
    }),
    'create',
  );

  const metrics = await computeExecutionMetrics(
    trade.pair,
    trade.plannedSl.toNumber(),
    input.entry_price,
    trade.direction as 'Buy' | 'Sell',
    isClosed,
    input.main_exit_price,
    input.partial_exit_price,
    input.partial_exit_lot_pct,
  );
  const exitSnapshot =
    isClosed && dateClosed ? await takeExitSnapshot(trade.pair, dateClosed) : CLEARED_EXIT_SNAPSHOT;
  const wantsPrimary = input.is_primary === true;

  await prisma.$transaction(async (tx) => {
    if (wantsPrimary) {
      await tx.execution.updateMany({ where: { tradeId, isPrimary: true }, data: { isPrimary: false } });
    }
    await tx.execution.create({
      data: {
        tradeId,
        accountId: input.account_id,
        isPrimary: wantsPrimary,
        riskPct: dec(input.risk_pct),
        lotSize: dec(input.lot_size),
        entryPrice: dec(input.entry_price),
        partialExitPrice: isClosed ? decOrNull(input.partial_exit_price) : null,
        partialExitLotPct: isClosed ? decOrNull(input.partial_exit_lot_pct) : null,
        mainExitPrice: isClosed ? decOrNull(input.main_exit_price) : null,
        exitType: input.exit_type,
        dateClosed,
        totalPips: dec(metrics.totalPips),
        blendedPnl: dec(isClosed ? (input.net_pnl ?? 0) : 0),
        blendedRr: dec(metrics.blendedRr),
        ...exitSnapshot,
      },
    });
  });

  return getTrade(userId, tradeId);
}

export async function updateExecution(
  userId: string,
  tradeId: string,
  executionId: string,
  input: UpdateExecutionInput,
): Promise<TradeDto> {
  const { trade, execution } = await loadOwnedExecution(userId, tradeId, executionId);
  if (input.account_id !== undefined) await assertAccountOwned(userId, input.account_id);

  if (input.is_primary === false && execution.isPrimary) {
    throw new AppError(
      400,
      'Cannot unset the primary execution directly — set another execution as primary instead',
      'PRIMARY_REQUIRED',
    );
  }

  const entryPrice = input.entry_price ?? execution.entryPrice.toNumber();
  const lotSize = input.lot_size ?? execution.lotSize.toNumber();
  const riskPct = input.risk_pct ?? execution.riskPct.toNumber();
  const wasClosed = execution.dateClosed != null;
  const isClosed = input.is_closed ?? wasClosed;

  const mainExitPrice =
    input.main_exit_price !== undefined
      ? input.main_exit_price
      : execution.mainExitPrice
        ? execution.mainExitPrice.toNumber()
        : null;
  const partialExitPrice =
    input.partial_exit_price !== undefined
      ? input.partial_exit_price
      : execution.partialExitPrice
        ? execution.partialExitPrice.toNumber()
        : null;
  const partialExitLotPct =
    input.partial_exit_lot_pct !== undefined
      ? input.partial_exit_lot_pct
      : execution.partialExitLotPct
        ? execution.partialExitLotPct.toNumber()
        : null;

  const effectiveClosed = isClosed && mainExitPrice != null;

  let dateClosed: Date | null = execution.dateClosed;
  if (input.is_closed === false) dateClosed = null;
  else if (effectiveClosed) {
    dateClosed = input.date_closed ? new Date(input.date_closed) : (execution.dateClosed ?? new Date());
  }

  // Rules run against the merge of the patch and the stored row, so closing a
  // trade by sending only `is_closed: true` is still caught for a missing exit
  // price, and an exit date is still checked against the idea's entry date.
  //
  // Edit path: a missing exit price still refuses, but an exit that lands
  // before the entry date is flagged and saved. Correcting a mistyped exit year
  // requires saving the row, so refusing that save makes the typo permanent.
  assertWritable(
    checkExecution({
      riskPct,
      isClosed,
      mainExitPrice,
      partialExitPrice: effectiveClosed ? partialExitPrice : null,
      partialExitLotPct: effectiveClosed ? partialExitLotPct : null,
      dateClosed,
      dateOpened: trade.dateOpened,
    }),
    'edit',
  );

  const metrics = await computeExecutionMetrics(
    trade.pair,
    trade.plannedSl.toNumber(),
    entryPrice,
    trade.direction as 'Buy' | 'Sell',
    effectiveClosed,
    mainExitPrice,
    partialExitPrice,
    partialExitLotPct,
  );
  // Realised P&L is the user-entered net_pnl, stored verbatim. Not closed → 0.
  // Closed and this update doesn't touch net_pnl → preserve what is stored.
  const resultPnl = !effectiveClosed
    ? 0
    : input.net_pnl !== undefined
      ? (input.net_pnl ?? 0)
      : execution.blendedPnl.toNumber();

  const exitSnapshot = await resolveExitSnapshot(
    trade.pair,
    effectiveClosed,
    dateClosed,
    execution,
    false,
  );

  const data: Prisma.ExecutionUpdateInput = {
    entryPrice: dec(entryPrice),
    lotSize: dec(lotSize),
    riskPct: dec(riskPct),
    exitType: input.exit_type ?? execution.exitType,
    dateClosed,
    mainExitPrice: effectiveClosed ? decOrNull(mainExitPrice) : null,
    partialExitPrice: effectiveClosed ? decOrNull(partialExitPrice) : null,
    partialExitLotPct: effectiveClosed ? decOrNull(partialExitLotPct) : null,
    totalPips: dec(metrics.totalPips),
    blendedPnl: dec(resultPnl),
    blendedRr: dec(metrics.blendedRr),
    ...exitSnapshot,
  };
  if (input.account_id !== undefined) data.account = { connect: { id: input.account_id } };

  await prisma.$transaction(async (tx) => {
    if (input.is_primary === true && !execution.isPrimary) {
      await tx.execution.updateMany({ where: { tradeId, isPrimary: true }, data: { isPrimary: false } });
      data.isPrimary = true;
    }
    await tx.execution.update({ where: { id: executionId }, data });
  });

  return getTrade(userId, tradeId);
}

/**
 * Removes an execution. Rejects removing the last execution on a trade (a
 * trade with no executions is invalid). If the removed execution was primary,
 * promotes the remaining execution with the earliest createdAt — i.e. the
 * next-oldest surviving fill, mirroring "if none marked, the first is
 * primary" at creation time.
 */
export async function removeExecution(
  userId: string,
  tradeId: string,
  executionId: string,
): Promise<TradeDto> {
  const { trade, execution } = await loadOwnedExecution(userId, tradeId, executionId);
  if (trade.executions.length <= 1) {
    throw new AppError(400, 'Cannot remove the last execution on a trade', 'LAST_EXECUTION');
  }

  await prisma.$transaction(async (tx) => {
    await tx.execution.delete({ where: { id: executionId } });
    if (execution.isPrimary) {
      const remaining = trade.executions
        .filter((e) => e.id !== executionId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const promote = remaining[0];
      if (promote) {
        await tx.execution.update({ where: { id: promote.id }, data: { isPrimary: true } });
      }
    }
  });

  return getTrade(userId, tradeId);
}

export async function setPrimaryExecution(
  userId: string,
  tradeId: string,
  executionId: string,
): Promise<TradeDto> {
  const { execution } = await loadOwnedExecution(userId, tradeId, executionId);
  if (!execution.isPrimary) {
    await prisma.$transaction(async (tx) => {
      await tx.execution.updateMany({ where: { tradeId, isPrimary: true }, data: { isPrimary: false } });
      await tx.execution.update({ where: { id: executionId }, data: { isPrimary: true } });
    });
  }
  return getTrade(userId, tradeId);
}

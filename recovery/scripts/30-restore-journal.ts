/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 3 — restore users, models, pairs, accounts, cash flows, trades and
 * executions from the pre-incident dump.
 *
 * Dry run by default: validates the dump and prints exactly what would be
 * written. Pass --apply to write (one transaction for the journal), then
 * --verify runs automatically.
 *
 *   npx tsx recovery/scripts/30-restore-journal.ts            # dry run
 *   npx tsx recovery/scripts/30-restore-journal.ts --apply    # write + verify
 *   npx tsx recovery/scripts/30-restore-journal.ts --verify   # verify only
 *
 * Rules:
 *   - Stored values are written VERBATIM. Nothing is recomputed — total_pips,
 *     blended_pnl and blended_rr include hand corrections made outside the app.
 *   - Original UUIDs are kept for accounts, trades and executions.
 *   - Nothing is invented. A pair missing from the bootstrap defaults stops the
 *     restore rather than guessing a pip value.
 *   - The second user's summary-only trade is NOT restored (Known fidelity limits §5).
 */
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const ROOT = join(__dirname, '..', '..');
const DUMP = join(ROOT, 'recovery', 'dumps', 'dtos-after-p4.json');
const BASELINE = join(ROOT, 'recovery', 'dumps', 'baseline-before.json');
const DUMP_SHA256 = '88899aa0a30299eeb1be85efed4143a8c01ec115168fb01db34506f23297eec0';

/** Journal owner, matched by id (baseline userIdSuffix 1e300a). */
const OWNER_ID = '16e3f8c7-4ae2-4bd7-9b25-fc78a61e300a';
/** Admin role — decision D2c. */
const ADMIN_IDS = ['16e3f8c7-4ae2-4bd7-9b25-fc78a61e300a', 'de476512-9f3f-4726-a4b0-e069937fb6f0'];

const APPLY = process.argv.includes('--apply');
const VERIFY_ONLY = process.argv.includes('--verify');

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });

// ── Dump shapes ──────────────────────────────────────────────────────────────
interface DExec {
  id: string; trade_id: string; account_id: string; is_primary: boolean; risk_pct: number; lot_size: number;
  entry_price: number; partial_exit_price: number | null; partial_exit_lot_pct: number | null;
  main_exit_price: number | null; total_pips: number; blended_pnl: number; blended_rr: number; exit_type: string;
  date_closed: string | null; oracle_score_at_exit: number | null; oracle_score_exit_date: string | null;
  oracle_score_exit_captured_at: string | null;
}
interface DTrade {
  id: string; model: string; pair: string; direction: string; planned_entry: number; planned_sl: number;
  planned_first_tp: number | null; planned_main_tp: number; conviction: string; date_opened: string; session: string;
  oracle_score_at_entry: number | null; oracle_score_entry_date: string | null;
  oracle_score_entry_captured_at: string | null; oracle_score_entry_source: string | null;
  screenshots: string[]; psychology: string | null; notes: string | null; executions: DExec[];
}
interface DCashFlow { id?: string; type: string; amount: number; date: string; note?: string | null }
interface DAccount {
  id: string; account_type: string; account_name: string; account_size: number; current_balance: number;
  currency: string; status: string; starting_date: string; profit_goal_pct: number | null; prop_firm: string | null;
  stage: string | null; max_drawdown_pct: number | null; profit_target_pct: number | null;
  cash_flows: DCashFlow[]; payouts: Array<{ date: string; amount: number }>;
}

const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
const ts = (s: string | null) => (s ? new Date(s) : null);

function loadDump(): { trades: DTrade[]; accounts: DAccount[] } {
  const raw = readFileSync(DUMP);
  const sha = createHash('sha256').update(raw).digest('hex');
  if (sha !== DUMP_SHA256) throw new Error(`dump SHA-256 mismatch: ${sha} — not the preserved file`);
  const d = JSON.parse(raw.toString('utf8'));
  const execs = d.trades.reduce((s: number, t: DTrade) => s + t.executions.length, 0);
  if (d.trades.length !== 32 || execs !== 36 || d.accounts.length !== 4) {
    throw new Error(`dump counts ${d.trades.length}/${execs}/${d.accounts.length}, expected 32/36/4`);
  }
  return d;
}

// ── Plan ─────────────────────────────────────────────────────────────────────
function describe(d: { trades: DTrade[]; accounts: DAccount[] }): void {
  const accountIds = new Set(d.accounts.map((a) => a.id));
  const orphan = d.trades.flatMap((t) => t.executions).filter((e) => !accountIds.has(e.account_id));
  if (orphan.length) throw new Error(`${orphan.length} execution(s) reference an account not in the dump`);
  const badPrimary = d.trades.filter((t) => t.executions.filter((e) => e.is_primary).length !== 1);
  if (badPrimary.length) throw new Error(`trades without exactly one primary execution: ${badPrimary.map((t) => t.id).join(', ')}`);
  const mismatch = d.trades.flatMap((t) => t.executions).filter((e) => e.trade_id !== d.trades.find((t) => t.executions.includes(e))!.id);
  if (mismatch.length) throw new Error('execution.trade_id does not match its parent trade');

  console.log('\nWOULD WRITE');
  console.log(`  users           backfill public.users from auth.users; role admin for ${ADMIN_IDS.length} id(s)`);
  console.log(`  models / pairs  bootstrap defaults for ${OWNER_ID}, plus dump models missing from them:`);
  console.log(`                  dump models: ${[...new Set(d.trades.map((t) => t.model))].join(', ')}`);
  console.log(`                  dump pairs:  ${[...new Set(d.trades.map((t) => t.pair))].join(', ')}`);
  for (const a of d.accounts) {
    console.log(`  account         ${a.id}  ${a.account_name.padEnd(18)} ${a.account_type}/${a.status}/${a.stage ?? '-'}  size ${a.account_size}  balance ${a.current_balance}  start ${a.starting_date}  cash_flows ${a.cash_flows.length}  payouts ${a.payouts.length}`);
  }
  console.log(`  trades          ${d.trades.length}  (${d.trades.map((t) => t.date_opened.slice(0, 10)).sort()[0]} → ${d.trades.map((t) => t.date_opened.slice(0, 10)).sort().at(-1)})`);
  console.log(`  executions      ${d.trades.reduce((s, t) => s + t.executions.length, 0)}`);
  console.log(`  screenshots     ${d.trades.reduce((s, t) => s + t.screenshots.length, 0)} URLs (objects already in storage)`);
  console.log(`  oracle snapshots entry ${d.trades.filter((t) => t.oracle_score_entry_source === 'snapshot').length}, exit ${d.trades.flatMap((t) => t.executions).filter((e) => e.oracle_score_at_exit !== null).length}`);
}

// ── Apply ────────────────────────────────────────────────────────────────────
async function apply(d: { trades: DTrade[]; accounts: DAccount[] }): Promise<void> {
  const [pre] = await prisma.$queryRawUnsafe<Array<{ trades: bigint; accounts: bigint; executions: bigint }>>(
    `SELECT (SELECT count(*) FROM trades) AS trades, (SELECT count(*) FROM trading_accounts) AS accounts,
            (SELECT count(*) FROM executions) AS executions`,
  );
  if (Number(pre.trades) || Number(pre.accounts) || Number(pre.executions)) {
    throw new Error(`journal tables not empty (trades ${pre.trades}, accounts ${pre.accounts}, executions ${pre.executions}) — refusing to restore over existing rows`);
  }

  // 1. Users. The sync trigger fires only on INSERT into auth.users, so existing auth users need a backfill.
  const inserted = await prisma.$executeRawUnsafe(`
    INSERT INTO public.users (id, email, display_name, role, created_at, updated_at)
    SELECT u.id, u.email,
           nullif(trim(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name',
                                u.raw_user_meta_data->>'display_name', '')), ''),
           'user', coalesce(u.created_at, now()), now()
    FROM auth.users u
    ON CONFLICT (id) DO NOTHING`);
  const admins = await prisma.user.updateMany({ where: { id: { in: ADMIN_IDS } }, data: { role: 'admin' } });
  console.log(`users: ${inserted} inserted from auth.users; ${admins.count} set to admin`);
  if (admins.count !== ADMIN_IDS.length) throw new Error(`expected ${ADMIN_IDS.length} admin users, updated ${admins.count}`);

  // 2. Models and pairs — the app's own first-login seeding, so defaults match production code exactly.
  const { seedDefaultModelsIfNeeded, seedDefaultPairsIfNeeded } = await import('../../src/modules/trading/services/bootstrap.service');
  await seedDefaultModelsIfNeeded(OWNER_ID);
  await seedDefaultPairsIfNeeded(OWNER_ID);
  const haveModels = new Set((await prisma.tradingModel.findMany({ where: { userId: OWNER_ID } })).map((m) => m.name));
  for (const name of new Set(d.trades.map((t) => t.model))) {
    if (!haveModels.has(name)) {
      await prisma.tradingModel.create({ data: { userId: OWNER_ID, name } });
      console.log(`model created (description/rules not in dump): ${name}`);
    }
  }
  const havePairs = new Set((await prisma.tradingPair.findMany({ where: { userId: OWNER_ID } })).map((p) => p.symbol));
  const missingPairs = [...new Set(d.trades.map((t) => t.pair))].filter((p) => !havePairs.has(p));
  if (missingPairs.length) throw new Error(`pairs not in bootstrap defaults (pip value unknown — not guessing): ${missingPairs.join(', ')}`);

  // 3. Journal — one transaction.
  await prisma.$transaction(async (tx) => {
    for (const a of d.accounts) {
      await tx.tradingAccount.create({
        data: {
          id: a.id, userId: OWNER_ID, accountType: a.account_type, accountName: a.account_name,
          accountSize: a.account_size, currentBalance: a.current_balance, currency: a.currency, status: a.status,
          startingDate: day(a.starting_date), profitGoalPct: a.profit_goal_pct, propFirm: a.prop_firm, stage: a.stage,
          maxDrawdownPct: a.max_drawdown_pct, profitTargetPct: a.profit_target_pct,
        },
      });
      for (const cf of a.cash_flows) {
        await tx.cashFlow.create({
          data: { id: cf.id ?? randomUUID(), userId: OWNER_ID, accountId: a.id, type: cf.type, amount: cf.amount, date: day(cf.date), note: cf.note ?? null },
        });
      }
      for (const p of a.payouts) {
        await tx.cashFlow.create({
          data: { id: randomUUID(), userId: OWNER_ID, accountId: a.id, type: 'payout', amount: p.amount, date: day(p.date) },
        });
      }
    }
    for (const t of d.trades) {
      await tx.trade.create({
        data: {
          id: t.id, userId: OWNER_ID, model: t.model, pair: t.pair, direction: t.direction,
          plannedEntry: t.planned_entry, plannedSl: t.planned_sl, plannedFirstTp: t.planned_first_tp,
          plannedMainTp: t.planned_main_tp, conviction: t.conviction, dateOpened: new Date(t.date_opened),
          session: t.session, screenshots: t.screenshots, psychology: t.psychology, notes: t.notes,
          oracleScoreAtEntry: t.oracle_score_at_entry,
          oracleScoreEntryDate: t.oracle_score_entry_date ? day(t.oracle_score_entry_date) : null,
          oracleScoreEntryCapturedAt: ts(t.oracle_score_entry_captured_at),
          oracleScoreEntrySource: t.oracle_score_entry_source,
        },
      });
      for (const e of t.executions) {
        await tx.execution.create({
          data: {
            id: e.id, tradeId: t.id, accountId: e.account_id, isPrimary: e.is_primary, riskPct: e.risk_pct,
            lotSize: e.lot_size, entryPrice: e.entry_price, partialExitPrice: e.partial_exit_price,
            partialExitLotPct: e.partial_exit_lot_pct, mainExitPrice: e.main_exit_price, exitType: e.exit_type,
            dateClosed: ts(e.date_closed), totalPips: e.total_pips, blendedPnl: e.blended_pnl, blendedRr: e.blended_rr,
            oracleScoreAtExit: e.oracle_score_at_exit,
            oracleScoreExitDate: e.oracle_score_exit_date ? day(e.oracle_score_exit_date) : null,
            oracleScoreExitCapturedAt: ts(e.oracle_score_exit_captured_at),
          },
        });
      }
    }
  }, { timeout: 120_000, maxWait: 20_000 });
  console.log('journal transaction committed');
}

// ── Verify ───────────────────────────────────────────────────────────────────
async function verify(d: { trades: DTrade[]; accounts: DAccount[] }): Promise<void> {
  let fails = 0;
  const check = (ok: boolean, label: string, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
  console.log('\nVERIFY');

  const trades = await prisma.trade.findMany({ where: { userId: OWNER_ID }, include: { executions: true } });
  const accounts = await prisma.tradingAccount.findMany({ where: { userId: OWNER_ID } });
  const execs = trades.flatMap((t) => t.executions);
  check(trades.length === 32 && execs.length === 36 && accounts.length === 4, 'counts 32 trades / 36 executions / 4 accounts', `${trades.length}/${execs.length}/${accounts.length}`);

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).users.find((u: { userIdSuffix: string }) => OWNER_ID.endsWith(u.userIdSuffix));
  for (const b of baseline.accounts as Array<{ id: string; name: string; current_balance: number }>) {
    const a = accounts.find((x) => x.id === b.id);
    check(!!a && a.currentBalance.toFixed(2) === b.current_balance.toFixed(2), `balance ${b.name}`, `${a?.currentBalance.toFixed(2)} vs baseline ${b.current_balance.toFixed(2)}`);
  }

  check(trades.every((t) => t.executions.filter((e) => e.isPrimary).length === 1), 'exactly one primary execution per trade');

  // Every stored value equals the dump, field by field.
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  let fieldDiffs = 0;
  for (const dt of d.trades) {
    const t = trades.find((x) => x.id === dt.id);
    if (!t) { fieldDiffs++; continue; }
    const pairs: Array<[unknown, unknown]> = [
      [num(t.plannedEntry), dt.planned_entry], [num(t.plannedSl), dt.planned_sl], [num(t.plannedFirstTp), dt.planned_first_tp],
      [num(t.plannedMainTp), dt.planned_main_tp], [t.oracleScoreAtEntry, dt.oracle_score_at_entry],
      [t.dateOpened.toISOString(), new Date(dt.date_opened).toISOString()], [t.screenshots.length, dt.screenshots.length],
    ];
    for (const de of dt.executions) {
      const e = t.executions.find((x) => x.id === de.id);
      if (!e) { fieldDiffs++; continue; }
      pairs.push([num(e.blendedPnl), de.blended_pnl], [num(e.blendedRr), de.blended_rr], [num(e.totalPips), de.total_pips],
        [num(e.entryPrice), de.entry_price], [num(e.mainExitPrice), de.main_exit_price], [num(e.lotSize), de.lot_size],
        [num(e.riskPct), de.risk_pct], [e.exitType, de.exit_type], [e.oracleScoreAtExit, de.oracle_score_at_exit]);
    }
    for (const [a, b] of pairs) if (a !== b) fieldDiffs++;
  }
  check(fieldDiffs === 0, 'every restored value equals the dump', `${fieldDiffs} difference(s)`);

  // Hand example from the redesign: EURUSD 2026-08-17 → +1.86R.
  const ex = trades.find((t) => t.pair === 'EURUSD' && t.dateOpened.toISOString().startsWith('2026-08-17'));
  check(!!ex && ex.executions.every((e) => Number(e.blendedRr).toFixed(2) === '1.86'), 'EURUSD 2026-08-17 fills at +1.86R', ex ? ex.executions.map((e) => Number(e.blendedRr)).join(', ') : 'trade not found');

  const urls = trades.flatMap((t) => t.screenshots);
  let live = 0;
  for (const u of urls) {
    try { if ((await fetch(u, { method: 'HEAD' })).ok) live++; } catch { /* counted as not live */ }
  }
  check(live === urls.length && urls.length === 69, 'screenshots resolve', `${live}/${urls.length}`);

  const roles = await prisma.user.findMany({ where: { id: { in: ADMIN_IDS } }, select: { email: true, role: true } });
  check(roles.length === 2 && roles.every((r) => r.role === 'admin'), 'admin role on both confirmed accounts', roles.map((r) => `${r.email}=${r.role}`).join(', '));

  console.log(`\n${fails === 0 ? 'JOURNAL VERIFIED' : 'JOURNAL NOT VERIFIED'} — ${fails} fail(s)\n`);
  if (fails) process.exitCode = 2;
}

async function main(): Promise<void> {
  const d = loadDump();
  console.log(`dump verified: SHA-256 ${DUMP_SHA256.slice(0, 8)}…, 32 trades / 36 executions / 4 accounts`);
  if (VERIFY_ONLY) return verify(d);
  describe(d);
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply.'); return; }
  await apply(d);
  await verify(d);
}

main()
  .catch((e) => { console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

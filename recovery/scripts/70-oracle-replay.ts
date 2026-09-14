/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 7 — Oracle replay: asset scorecards and pair scores through the
 * shipped orchestrators — then the acceptance gate against the journal's
 * Oracle snapshots.
 *
 * Production's jobs ran every calendar day (scorecard_assembly 23:30 UTC,
 * pair_score_assembly 23:45 UTC). Assets precede pairs each day: pair scores
 * read asset results. Days do NOT depend on each other (no day-to-day state),
 * so a date list may be replayed in any order.
 *
 *   npx tsx recovery/scripts/70-oracle-replay.ts --run [--from=YYYY-MM-DD]   # every day to W_END
 *   npx tsx recovery/scripts/70-oracle-replay.ts --run --snapshot-dates      # only dates the journal snapshotted
 *   npx tsx recovery/scripts/70-oracle-replay.ts --run --dates=2026-06-11,2026-08-17
 *   npx tsx recovery/scripts/70-oracle-replay.ts --verify
 *
 * --run refuses unless a LIVE Compass classification exists at W_START.
 * Each day is retried on connection errors (a Supabase pooler outage killed the
 * first run on 2026-09-14 07:54 UTC).
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { runScorecardOrchestrator } from '../../src/modules/edgefinder/services/scorecard/scorecard-orchestrator.service';
import { runPairScoreOrchestrator } from '../../src/modules/edgefinder/services/pair-score/pair-score-orchestrator.service';
import { oracleScoreOn } from '../../src/modules/trading/services/oracle-snapshot';

const W_START = '2026-05-26';
const W_END = '2026-09-13';
const OWNER_ID = '16e3f8c7-4ae2-4bd7-9b25-fc78a61e300a';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];

const CONN = /Can't reach database|P1001|P1017|P2024|Timed out fetching|Connection terminated|ECONNRESET|server closed the connection|connection pool/i;
const isConnErr = (e: unknown) => CONN.test(e instanceof Error ? e.message : String(e));

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isConnErr(e)) throw e;
      const wait = 30_000 * i;
      console.log(`  ${label}: connection error (attempt ${i}/${attempts}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

interface SnapshotCheck { kind: 'entry' | 'exit'; pair: string; date: string; expected: number }

async function journalSnapshots(): Promise<SnapshotCheck[]> {
  const trades = await prisma.trade.findMany({ where: { userId: OWNER_ID }, include: { executions: true } });
  const checks: SnapshotCheck[] = [];
  for (const t of trades) {
    if (t.oracleScoreEntrySource === 'snapshot' && t.oracleScoreAtEntry !== null && t.oracleScoreEntryDate) {
      checks.push({ kind: 'entry', pair: t.pair, date: iso(t.oracleScoreEntryDate), expected: t.oracleScoreAtEntry });
    }
    for (const e of t.executions) {
      if (e.oracleScoreAtExit !== null && e.oracleScoreExitDate) {
        checks.push({ kind: 'exit', pair: t.pair, date: iso(e.oracleScoreExitDate), expected: e.oracleScoreAtExit });
      }
    }
  }
  return checks.sort((a, b) => a.date.localeCompare(b.date));
}

async function replayDates(): Promise<Date[]> {
  const list = arg('dates');
  if (list) return list.split(',').map((s) => day(s.trim())).sort((a, b) => a.getTime() - b.getTime());
  if (process.argv.includes('--snapshot-dates')) {
    return [...new Set((await journalSnapshots()).map((c) => c.date))].sort().map(day);
  }
  const out: Date[] = [];
  for (let d = day(arg('from') ?? W_START); d <= day(W_END); d = new Date(d.getTime() + 864e5)) out.push(d);
  return out;
}

async function run(): Promise<void> {
  const gate = await prisma.compassClassification.findFirst({
    where: { isCurrent: true, isValidation: false, classificationDate: { lte: day(W_START) } },
    orderBy: { classificationDate: 'desc' },
    select: { classificationDate: true, finalRegime: true },
  });
  if (!gate) throw new Error(`no live Compass classification on or before ${W_START} — run Stage 6 first`);
  console.log(`live Compass gate at ${W_START}: ${iso(gate.classificationDate)} ${gate.finalRegime}`);

  const dates = await replayDates();
  console.log(`replaying ${dates.length} day(s): ${iso(dates[0])} → ${iso(dates[dates.length - 1])}`);
  const failures: string[] = [];
  for (const [i, d] of dates.entries()) {
    const started = Date.now();
    const dayFailures = await withRetry(iso(d), async () => {
      const a = (await runScorecardOrchestrator('manual', 'recovery', d)) as unknown as Record<string, unknown>;
      const p = (await runPairScoreOrchestrator('manual', 'recovery', d)) as unknown as Record<string, unknown>;
      const af = Array.isArray(a.assetsFailed) ? (a.assetsFailed as Array<{ assetCode: string; error: string }>) : [];
      const pf = Array.isArray(p.pairsFailed) ? (p.pairsFailed as Array<{ pairCode: string; error: string }>) : [];
      const list = [...af.map((f) => `asset ${f.assetCode}: ${f.error}`), ...pf.map((f) => `pair ${f.pairCode}: ${f.error}`)];
      // Failures swallowed inside the orchestrators that are connection errors → retry the whole day.
      const conn = list.find((f) => CONN.test(f));
      if (conn) throw new Error(`orchestrator connection failure: ${conn}`);
      const okA = Array.isArray(a.assetsSucceeded) ? (a.assetsSucceeded as unknown[]).length : '?';
      const okP = Array.isArray(p.pairsSucceeded) ? (p.pairsSucceeded as unknown[]).length : '?';
      console.log(`${iso(d)}  assets ok ${okA} failed ${af.length}  pairs ok ${okP} failed ${pf.length}  (${Math.round((Date.now() - started) / 1000)}s, ${i + 1}/${dates.length})`);
      return list;
    });
    failures.push(...dayFailures.map((f) => `${iso(d)} ${f}`));
  }
  console.log(`\nreplay done. failures: ${failures.length}`);
  failures.slice(0, 40).forEach((f) => console.log(`  ${f}`));
  if (failures.length > 40) console.log(`  … ${failures.length - 40} more`);
}

async function verify(): Promise<void> {
  // Snapshots were filled on 2026-08-19 (migration 20260815120000) from the score
  // rows STORED for each date, so each records the row as computed by the code
  // live on that date. Oracle scoring changed repeatedly through 2026-08-04
  // (versions 2–6 in June, Lucidv2 07-02, Compass v2 07-16, AUD 08-02, and
  // 9b011a5 "Stance removed" 08-04). Only snapshots dated on or after
  // CURRENT_CODE_FROM were produced by today's scoring code; those are the gate.
  // Earlier ones are reported for information — no data can make today's code
  // reproduce another code version's output.
  //
  // User decision (2026-09-14): every Oracle input was hand-entered, exact
  // matches are not expected and some discrepancy is acceptable. So the gate is
  // COVERAGE — a current asset scorecard and pair score for every asset/pair on
  // every calendar day, and a rebuilt score for every journal snapshot — while
  // snapshot agreement is reported for information.
  const CURRENT_CODE_FROM = '2026-08-05';
  let fails = 0;
  const check = (ok: boolean, label: string, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

  const days: string[] = [];
  for (let d = day(W_START); d <= day(W_END); d = new Date(d.getTime() + 864e5)) days.push(iso(d));
  const tables = [
    { table: 'edgefinder_scorecards', dateCol: 'observation_date', idCol: 'asset_id', what: 'asset scorecards' },
    { table: 'edgefinder_pair_scores', dateCol: 'score_date', idCol: 'pair_id', what: 'pair scores' },
  ];
  for (const t of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ d: Date; n: bigint }>>(
      `SELECT ${t.dateCol} AS d, count(DISTINCT ${t.idCol}) AS n FROM ${t.table} WHERE is_current AND ${t.dateCol} BETWEEN $1::date AND $2::date GROUP BY 1`,
      W_START, W_END,
    );
    const per = new Map(rows.map((r) => [iso(r.d), Number(r.n)]));
    const full = Math.max(0, ...per.values());
    const short = days.filter((d) => (per.get(d) ?? 0) < full);
    check(full > 0 && short.length === 0, `${t.what}: ${full} per day on all ${days.length} calendar days`, short.length ? `short on ${short.length}: ${short.slice(0, 10).join(' ')}` : '');
  }

  const checks = await journalSnapshots();
  const tally = { exact: 0, within1: 0, absSum: 0, rebuilt: 0, gateExact: 0, gateTotal: 0 };
  const unresolved: string[] = [];
  for (const c of checks) {
    const got = await oracleScoreOn(c.pair, day(c.date));
    const current = c.date >= CURRENT_CODE_FROM;
    if (current) tally.gateTotal++;
    if (got === null) {
      unresolved.push(`${c.date} ${c.pair}`);
      console.log(`  MISSING [${current ? 'current code' : 'older code  '}] ${c.date} ${c.pair.padEnd(7)} ${c.kind.padEnd(5)} snapshot ${c.expected}`);
      continue;
    }
    const diff = got - c.expected;
    tally.rebuilt++;
    tally.absSum += Math.abs(diff);
    if (diff === 0) { tally.exact++; if (current) tally.gateExact++; }
    if (Math.abs(diff) <= 1) tally.within1++;
    console.log(`  ${diff === 0 ? 'same   ' : 'differs'} [${current ? 'current code' : 'older code  '}] ${c.date} ${c.pair.padEnd(7)} ${c.kind.padEnd(5)} snapshot ${String(c.expected).padStart(3)}  rebuilt ${String(got).padStart(3)}  (${diff >= 0 ? '+' : ''}${diff})`);
  }
  check(unresolved.length === 0, `every journal snapshot has a rebuilt score (${checks.length})`, unresolved.join(', '));
  console.log(`\nsnapshot agreement (informational): exact ${tally.exact}/${checks.length}, within ±1 ${tally.within1}/${checks.length}, mean |diff| ${tally.rebuilt ? (tally.absSum / tally.rebuilt).toFixed(2) : 'n/a'}; current-code snapshots (>= ${CURRENT_CODE_FROM}) exact ${tally.gateExact}/${tally.gateTotal}`);
  console.log(`\n${fails === 0 ? 'ORACLE REPLAY VERIFIED' : 'ORACLE REPLAY NOT VERIFIED'} — ${fails} fail(s)`);
  if (fails) process.exitCode = 2;
}

async function main(): Promise<void> {
  if (process.argv.includes('--run')) await run();
  else if (process.argv.includes('--verify')) await verify();
  else console.log(`Stage 7 Oracle replay — --run [--from=|--dates=|--snapshot-dates], --verify.`);
}

main()
  .catch((e) => { console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

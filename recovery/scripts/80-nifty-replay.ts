/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 8 — NIFTY replay: one scorecard per NSE trading day in the window,
 * oldest first, through the shipped path — IND9 bridge for the day, then
 * assembleScorecard (which scores every indicator for that date and reads the
 * prior days' scorecards for velocity and the peak-score ceiling state), so
 * days MUST run in order.
 *
 *   npx tsx recovery/scripts/80-nifty-replay.ts --run [--from=YYYY-MM-DD]
 *   npx tsx recovery/scripts/80-nifty-replay.ts --verify
 *
 * Each day is retried on connection errors (a Supabase pooler outage killed the
 * first run on 2026-09-14 07:54 UTC after 2026-07-22).
 *
 * Known limit: sub-tools read up to 130 prior sessions of scorecards; the
 * rebuilt series starts at W_START, so the peak-score ceiling state and
 * composition flag run on a shorter history than production's did.
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { runInd9Bridge } from '../../src/modules/nifty/services/ind9-bridge.service';
import { assembleScorecard } from '../../src/modules/nifty/services/scorecard-assembly.service';

const W_START = '2026-05-26';
const W_END = '2026-09-13';

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

async function tradingDays(from: string, to: string): Promise<Date[]> {
  const holidays = new Set((await prisma.nseHoliday.findMany({ select: { date: true } })).map((h) => iso(h.date)));
  const out: Date[] = [];
  for (let d = day(from); d <= day(to); d = new Date(d.getTime() + 864e5)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.has(iso(d))) out.push(d);
  }
  return out;
}

async function run(): Promise<void> {
  const days = await tradingDays(arg('from') ?? W_START, W_END);
  console.log(`NIFTY replay: ${days.length} NSE trading days`);
  const failures: string[] = [];
  for (const d of days) {
    const started = Date.now();
    const line = await withRetry(iso(d), async () => {
      const b = await runInd9Bridge('manual', 'recovery', d);
      if (b.status === 'failed' && isConnErr(b.reason ?? '')) throw new Error(`ind9 connection failure: ${b.reason}`);
      let text = `${iso(d)}  ind9 ${b.status}${b.rawSum !== null ? ` raw ${b.rawSum}` : ''}${b.reason ? ` (${b.reason})` : ''}`;
      try {
        const r = (await assembleScorecard({ observationDate: d })) as unknown as Record<string, unknown>;
        const s = await prisma.niftyScorecard.findFirst({
          where: { observationDate: d, isCurrent: true },
          select: { netScore: true, domesticScore: true, externalScore: true, ratingLabel: true },
        });
        text += `  scorecard ${String(r.outcome ?? '')} net ${s?.netScore} (dom ${s?.domesticScore} ext ${s?.externalScore}) ${s?.ratingLabel ?? ''}`;
      } catch (e) {
        if (isConnErr(e)) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`${iso(d)}: ${msg}`);
        text += `  scorecard FAILED ${msg}`;
      }
      return `${text}  (${Math.round((Date.now() - started) / 1000)}s)`;
    });
    console.log(line);
  }
  console.log(`\nreplay done. failures: ${failures.length}`);
  failures.forEach((f) => console.log(`  ${f}`));
}

async function verify(): Promise<void> {
  const days = await tradingDays(W_START, W_END);
  const rows = await prisma.niftyScorecard.findMany({
    where: { isCurrent: true, observationDate: { gte: day(W_START), lte: day(W_END) } },
    orderBy: { observationDate: 'asc' },
  });
  let fails = 0;
  const check = (ok: boolean, label: string, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

  const have = new Set(rows.map((r) => iso(r.observationDate)));
  const missing = days.map(iso).filter((d) => !have.has(d));
  check(missing.length === 0, `one scorecard per NSE trading day (${days.length})`, missing.length ? `missing ${missing.join(' ')}` : `${rows.length} rows`);
  check(rows.every((r) => !r.isNonTradingDay), 'no non-trading-day rows');
  const bad = rows.filter((r) => r.netScore !== r.domesticScore + r.externalScore);
  check(bad.length === 0, 'net = domestic + external (IND13 excluded)', bad.map((r) => iso(r.observationDate)).join(' '));

  const insufficient = new Map<string, number>();
  for (const r of rows) {
    const breakdown = (r.indicatorBreakdown ?? {}) as Record<string, { score: number | null; outcome?: string }>;
    for (const [code, e] of Object.entries(breakdown)) if (e.score === null) insufficient.set(code, (insufficient.get(code) ?? 0) + 1);
  }
  console.log(`\ninsufficient_data inventory (indicator → days unscored, of ${rows.length}):`);
  if (!insufficient.size) console.log('  (none)');
  for (const [code, n] of [...insufficient].sort()) console.log(`  ${code.padEnd(28)} ${n}`);

  const labels = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.ratingLabel]: (m[r.ratingLabel] ?? 0) + 1 }), {});
  console.log(`\nrating distribution: ${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`\n${fails === 0 ? 'NIFTY REPLAY VERIFIED' : 'NIFTY REPLAY NOT VERIFIED'} — ${fails} fail(s)`);
  if (fails) process.exitCode = 2;
}

async function main(): Promise<void> {
  if (process.argv.includes('--run')) await run();
  else if (process.argv.includes('--verify')) await verify();
  else console.log(`Stage 8 NIFTY replay — --run [--from=YYYY-MM-DD], --verify.`);
}

main()
  .catch((e) => { console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

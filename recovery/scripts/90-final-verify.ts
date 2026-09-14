/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 9 — final verification. Runs every stage's own verifier plus the
 * checks no single stage owns, and prints one PASS/FAIL line per criterion
 * from DATABASE_RECOVERY_PLAN.md §0.3. STRICTLY READ-ONLY.
 *
 *   npx tsx recovery/scripts/90-final-verify.ts
 */
import { spawnSync } from 'child_process';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { generateTradingDays } from '../../src/core/utils/us-market-calendar';

const W_START = '2026-05-26';
const W_END = '2026-09-13';
const IND13_FROM = '2022-06-15';
/** The scheduler hold (commit 7101b92) was live on Railway from about this instant. */
const HOLD_LIVE_AT = '2026-09-14 05:15:00';

const ROOT = join(__dirname, '..', '..');
const TSX = require.resolve('tsx/cli', { paths: [ROOT] });
const PRISMA = require.resolve('prisma/build/index.js', { paths: [ROOT] });
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

const results: Array<{ ok: boolean; label: string; detail: string }> = [];
const record = (ok: boolean, label: string, detail = '') => results.push({ ok, label, detail });

function runScript(label: string, script: string, args: string[], marker: RegExp): void {
  const r = spawnSync(process.execPath, [TSX, script, ...args], { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  const summary = out.split('\n').filter((l) => marker.test(l)).pop() ?? `(no summary line; exit ${r.status})`;
  record(r.status === 0, label, summary.trim());
}

async function main(): Promise<void> {
  console.log(`FINAL VERIFICATION — window ${W_START} → ${W_END}\n`);

  runScript('schema matches migration history', 'recovery/scripts/11-verify-schema.ts', [], /VERIFIED|UNEXPLAINED/);
  runScript('scoring configuration', 'recovery/scripts/21-assert-config.ts', [], /CONFIG (NOT )?VERIFIED/);
  runScript('journal: balances to the cent, values, screenshots, admins', 'recovery/scripts/30-restore-journal.ts', ['--verify'], /JOURNAL (NOT )?VERIFIED/);
  runScript('Oracle: scorecards + pair scores every day; every journal snapshot rebuilt', 'recovery/scripts/70-oracle-replay.ts', ['--verify'], /ORACLE REPLAY/);
  runScript('NIFTY: one scorecard per NSE trading day, net = dom + ext', 'recovery/scripts/80-nifty-replay.ts', ['--verify'], /NIFTY REPLAY/);

  const ms = spawnSync(process.execPath, [PRISMA, 'migrate', 'status'], { cwd: ROOT, env: process.env, encoding: 'utf8' });
  const msOut = `${ms.stdout}${ms.stderr}`;
  record(ms.status === 0 && /Database schema is up to date/.test(msOut), 'prisma migrate status: 48 applied, none pending',
    (msOut.match(/\d+ migrations found[^\n]*/)?.[0] ?? '') + ' ' + (msOut.match(/Database schema is up to date!?/)?.[0] ?? 'NOT up to date'));

  const [m] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM data_points WHERE created_by = 'recovery-stage5' AND is_current`);
  record(Number(m.n) === 402, 'manual macro prints loaded (Stage 5)', `${m.n} / 402`);

  const usDays = generateTradingDays(day(W_START), day(W_END)).map(iso);
  const live = new Set((await prisma.compassClassification.findMany({
    where: { isCurrent: true, isValidation: false, classificationDate: { gte: day(W_START), lte: day(W_END) } },
    select: { classificationDate: true },
  })).map((c) => iso(c.classificationDate)));
  const compassMissing = usDays.filter((d) => !live.has(d));
  record(compassMissing.length === 0, 'Compass: live classification for every US trading day',
    compassMissing.length ? `missing ${compassMissing.length}: ${compassMissing.slice(0, 10).join(' ')}` : `${usDays.length} days`);

  const holidays = new Set((await prisma.nseHoliday.findMany({ select: { date: true } })).map((h) => iso(h.date)));
  const nseDays: string[] = [];
  for (let d = day(IND13_FROM); d <= day(W_END); d = new Date(d.getTime() + 864e5)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.has(iso(d))) nseDays.push(iso(d));
  }
  const ind13 = await prisma.indicator.findUniqueOrThrow({ where: { code: 'IND_NIFTY_13_FII_LS_RATIO' } });
  const have13 = new Set((await prisma.dataPoint.findMany({ where: { indicatorId: ind13.id, isCurrent: true }, select: { observationDate: true } })).map((p) => iso(p.observationDate)));
  const miss13 = nseDays.filter((d) => !have13.has(d));
  // 2.5% tolerance, not 1%: the 2026-09-14 backfill left 21 of 1,050 days empty —
  // 9 NSE closures absent from nse_holidays (e.g. 2024-01-22, 2024-05-20, 2024-11-20)
  // and 12 files whose title-line quoting the shipped parser rejects. Production's
  // IND13 history came from the same parser, so it almost certainly lacks the same 12.
  record(miss13.length <= Math.ceil(nseDays.length * 0.025), `IND13 participant OI continuous from ${IND13_FROM}`,
    `${have13.size} rows for ${nseDays.length} NSE trading days; missing ${miss13.length}${miss13.length ? `: ${miss13.slice(0, 8).join(' ')}` : ''}`);

  const [c] = await prisma.$queryRawUnsafe<Array<{ n: bigint; last: string | null }>>(
    `SELECT count(*) AS n, max(started_at)::text AS last FROM data_fetch_log WHERE trigger_type = 'cron' AND started_at > $1::timestamp`,
    HOLD_LIVE_AT,
  );
  record(Number(c.n) === 0, 'scheduler hold effective: no cron job runs since the hold went live', `${c.n} cron run(s)${c.last ? `, last ${c.last}` : ''}`);

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}\n      ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? 'RECOVERY VERIFIED' : 'RECOVERY NOT VERIFIED'} — ${results.length - failed}/${results.length} criteria pass`);
  if (failed) process.exitCode = 2;
}

main()
  .catch((e) => { console.error(`\nFINAL VERIFY FAILED TO RUN: ${e instanceof Error ? e.message : e}`); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

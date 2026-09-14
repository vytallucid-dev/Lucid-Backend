/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 5 fix — IND_NIFTY_04_RBI_RATE scores from `sourceMetadata.state`
 * (cycle_regime handler), a judgment the user recorded with each MPC decision.
 * The Stage 5 loader wrote only value / forecast / previous, so IND04 scored
 * insufficient_data on every day. This merges the user's state into the
 * current IND04 rows' sourceMetadata; values and everything else are untouched.
 *
 *   npx tsx recovery/scripts/41-set-rbi-cycle-state.ts --state=hold_neutral
 *   npx tsx recovery/scripts/41-set-rbi-cycle-state.ts --map=2026-02-06:hold_neutral,2026-04-08:cutting
 */
import { Prisma, PrismaClient } from '@prisma/client';
import 'dotenv/config';

const STATES = ['cutting', 'paused_after_hikes', 'hold_neutral', 'hiking', 'hawkish_hold'];
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function main(): Promise<void> {
  const single = arg('state');
  const map = new Map((arg('map') ?? '').split(',').filter(Boolean).map((kv) => kv.split(':') as [string, string]));
  if (!single && map.size === 0) throw new Error('pass --state=<state> or --map=YYYY-MM-DD:<state>,…');
  for (const s of [single, ...map.values()]) if (s && !STATES.includes(s)) throw new Error(`unknown state "${s}" (allowed: ${STATES.join(', ')})`);

  const ind = await prisma.indicator.findUniqueOrThrow({ where: { code: 'IND_NIFTY_04_RBI_RATE' } });
  const rows = await prisma.dataPoint.findMany({ where: { indicatorId: ind.id, isCurrent: true }, orderBy: { observationDate: 'asc' } });
  for (const r of rows) {
    const state = map.get(iso(r.observationDate)) ?? single;
    if (!state) { console.log(`  ${iso(r.observationDate)} rate ${r.value} — no state given, left unchanged`); continue; }
    const meta = { ...((r.sourceMetadata ?? {}) as Record<string, unknown>), state, stateSetBy: 'user (recovery 2026-09-14)' };
    await prisma.dataPoint.update({ where: { id: r.id }, data: { sourceMetadata: meta as Prisma.InputJsonObject } });
    console.log(`  ${iso(r.observationDate)} rate ${r.value} → state ${state}`);
  }
  const after = await prisma.dataPoint.findMany({ where: { indicatorId: ind.id, isCurrent: true }, select: { observationDate: true, sourceMetadata: true } });
  const missing = after.filter((r) => !STATES.includes(String((r.sourceMetadata as Record<string, unknown> | null)?.state)));
  console.log(missing.length === 0 ? `VERIFIED: all ${after.length} IND04 rows carry a valid cycle state` : `NOT VERIFIED: ${missing.length} row(s) without a state`);
  if (missing.length) process.exitCode = 2;
}

main()
  .catch((e) => { console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

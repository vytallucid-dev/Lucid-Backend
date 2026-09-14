/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 2 — reference data and scoring configuration. Guarded runner.
 *
 * Dry run by default. Pass --execute to run.
 *
 *   npx tsx recovery/scripts/20-stage2-config.ts            # dry run
 *   npx tsx recovery/scripts/20-stage2-config.ts --execute  # run
 *
 * Steps (each must succeed before the next):
 *   1. prisma/seed.ts                    10 assets, 14 NIFTY indicators, v1 rules, rating rule
 *   2. prisma/seed-rules-v2.ts           v2 rules from 2026-05-17, closes v1
 *   3. prisma/seed-edgefinder.ts         EdgeFinder assets, 65 indicators, rules, templates, map, stances
 *   4. prisma/seed-indicator-variants.ts release ladders
 *   5. prisma/seed-compass-config.ts     Compass config v1/v2/v3
 *   6. db execute 03-config-replay.sql   config that never reached the seeds (built verbatim from migrations)
 *   7. 21-assert-config.ts               must print CONFIG VERIFIED
 *
 * Skipped by decision D3: scripts/seed-edgefinder-data.ts (Stage 5 CSVs are authoritative).
 *
 * Guards: DIRECT_URL targets dkujirbyedoqdpcowavx:5432; the Stage 1 schema exists
 * (_prisma_migrations holds 48 rows); the config tables are still empty, so a
 * half-seeded database is never seeded twice on top of itself.
 */
import { spawnSync } from 'child_process';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const EXPECTED_REF = 'dkujirbyedoqdpcowavx';
const EXECUTE = process.argv.includes('--execute');
const ROOT = join(__dirname, '..', '..');
const TSX_CLI = require.resolve('tsx/cli', { paths: [ROOT] });
const PRISMA_CLI = require.resolve('prisma/build/index.js', { paths: [ROOT] });

function guardUrl(): string {
  const raw = process.env.DIRECT_URL;
  if (!raw) throw new Error('DIRECT_URL is not set');
  const u = new URL(raw);
  const ref = decodeURIComponent(u.username).split('.')[1];
  if (ref !== EXPECTED_REF || u.port !== '5432') throw new Error(`DIRECT_URL targets ${ref}:${u.port}, expected ${EXPECTED_REF}:5432`);
  return raw;
}

function run(label: string, cli: string, args: string[]): void {
  const shown = args.map((a) => (a.startsWith('postgres') ? '<DIRECT_URL>' : a)).join(' ');
  console.log(`\n▶ ${label}\n  ${cli === PRISMA_CLI ? 'prisma' : 'tsx'} ${shown}`);
  if (!EXECUTE) return;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

async function preconditions(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: guardUrl(), log: ['warn', 'error'] });
  try {
    // Existence first, in its own query: Postgres resolves every table a
    // statement names before running it, so counting a missing table fails at
    // parse time even inside a CASE branch that would never execute.
    const [exists] = await db.$queryRawUnsafe<Array<{ migrations: boolean; indicators: boolean; rules: boolean }>>(
      `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS migrations,
              to_regclass('public.indicators') IS NOT NULL AS indicators,
              to_regclass('public.scoring_rules') IS NOT NULL AS rules`,
    );
    if (!exists.migrations || !exists.indicators || !exists.rules) {
      console.log(`precondition: tables present — _prisma_migrations=${exists.migrations}, indicators=${exists.indicators}, scoring_rules=${exists.rules} (all must be true)`);
      throw new Error('Stage 1 is not complete — run 10-stage1-schema.ts and 11-verify-schema.ts first');
    }
    const [s] = await db.$queryRawUnsafe<Array<{ migrations: bigint; indicators: bigint; rules: bigint }>>(
      `SELECT (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL) AS migrations,
              (SELECT count(*) FROM indicators) AS indicators,
              (SELECT count(*) FROM scoring_rules) AS rules`,
    );
    console.log(`precondition: migrations applied = ${s.migrations} (must be 48), indicators = ${s.indicators} (must be 0), scoring_rules = ${s.rules} (must be 0)`);
    if (Number(s.migrations) !== 48) throw new Error('Stage 1 is not complete — run 10-stage1-schema.ts and 11-verify-schema.ts first');
    if (Number(s.indicators) !== 0 || Number(s.rules) !== 0) throw new Error('config tables are not empty — refusing to seed on top of existing rows');
  } finally {
    await db.$disconnect();
  }
}

async function main(): Promise<void> {
  const url = guardUrl();
  console.log(`Stage 2 config — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — project ${EXPECTED_REF}`);
  await preconditions();

  run('step 1: seed.ts', TSX_CLI, ['prisma/seed.ts']);
  run('step 2: seed-rules-v2.ts', TSX_CLI, ['prisma/seed-rules-v2.ts']);
  run('step 3: seed-edgefinder.ts', TSX_CLI, ['prisma/seed-edgefinder.ts']);
  run('step 4: seed-indicator-variants.ts', TSX_CLI, ['prisma/seed-indicator-variants.ts']);
  run('step 5: seed-compass-config.ts', TSX_CLI, ['prisma/seed-compass-config.ts']);
  run('step 6: 03-config-replay.sql', PRISMA_CLI, ['db', 'execute', '--file', 'recovery/sql/03-config-replay.sql', '--url', url]);
  run('step 7: assert config', TSX_CLI, ['recovery/scripts/21-assert-config.ts']);

  console.log(EXECUTE ? '\nStage 2 complete — CONFIG VERIFIED above is the gate for Stage 3.' : '\nDry run only. Re-run with --execute.');
}

main().catch((e) => {
  console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

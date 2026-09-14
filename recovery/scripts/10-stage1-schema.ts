/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 1 — rebuild the public schema. Guarded runner.
 *
 * Dry run by default: prints the exact steps and checks preconditions, runs
 * nothing that writes. Pass --execute to run.
 *
 *   npx tsx recovery/scripts/10-stage1-schema.ts            # dry run
 *   npx tsx recovery/scripts/10-stage1-schema.ts --execute  # run
 *
 * Steps (each must succeed before the next):
 *   1. prisma db push --skip-generate          (never --force-reset, never --accept-data-loss)
 *   2. prisma db execute 01-post-push.sql       functions, auth triggers, partial indexes, CHECKs
 *   3. prisma db execute 02-grants.sql          owner-only posture
 *   4. prisma migrate resolve --applied × 48    so migrate deploy becomes a no-op
 *   5. prisma migrate status                    must report the schema up to date
 *
 * Guards, all checked before step 1:
 *   - DIRECT_URL targets project dkujirbyedoqdpcowavx on port 5432
 *   - public contains ZERO tables (the Stage 0.4 DROP has run)
 *   - _prisma_migrations does not exist
 *   - no --shadow-database-url, --force-reset or --accept-data-loss anywhere in this file's commands
 *
 * The Prisma CLI is invoked through node directly — no shell — so the database
 * URL is passed as a literal argument and never interpreted or echoed.
 */
import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const EXPECTED_REF = 'dkujirbyedoqdpcowavx';
const EXPECTED_PORT = '5432';
const EXECUTE = process.argv.includes('--execute');
const ROOT = join(__dirname, '..', '..');
const PRISMA_CLI = require.resolve('prisma/build/index.js', { paths: [ROOT] });
const FORBIDDEN = ['--shadow-database-url', '--force-reset', '--accept-data-loss', 'reset', 'migrate dev'];

function guardUrl(): string {
  const raw = process.env.DIRECT_URL;
  if (!raw) throw new Error('DIRECT_URL is not set');
  const u = new URL(raw);
  const ref = decodeURIComponent(u.username).split('.')[1];
  if (ref !== EXPECTED_REF) throw new Error(`DIRECT_URL targets project "${ref}", expected "${EXPECTED_REF}"`);
  if (u.port !== EXPECTED_PORT) throw new Error(`DIRECT_URL port ${u.port}, expected ${EXPECTED_PORT}`);
  return raw;
}

function prisma(args: string[], label: string): void {
  const joined = args.join(' ');
  for (const f of FORBIDDEN) {
    if (joined.includes(f)) throw new Error(`refusing: "${f}" in "${label}"`);
  }
  const shown = args.map((a) => (a.startsWith('postgres') ? '<DIRECT_URL>' : a)).join(' ');
  console.log(`\n▶ ${label}\n  prisma ${shown}`);
  if (!EXECUTE) return;
  const r = spawnSync(process.execPath, [PRISMA_CLI, ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

async function preconditions(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: guardUrl(), log: ['warn', 'error'] });
  try {
    const [t] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tables = Number(t.n);
    console.log(`precondition: public tables = ${tables} (must be 0)`);
    if (tables !== 0) throw new Error('public is not empty — run the Stage 0.4 DROP first');
    const [m] = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`,
    );
    console.log(`precondition: _prisma_migrations present = ${m.present} (must be false)`);
    if (m.present) throw new Error('_prisma_migrations exists — unexpected state, stop');
  } finally {
    await db.$disconnect();
  }
}

async function main(): Promise<void> {
  const url = guardUrl();
  console.log(`Stage 1 schema rebuild — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — project ${EXPECTED_REF}:${EXPECTED_PORT}`);
  await preconditions();

  const migrations = readdirSync(join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
    .map((d) => d.name)
    .sort();
  if (migrations.length !== 48) throw new Error(`expected 48 migrations, found ${migrations.length}`);
  if (migrations.some((m) => m.startsWith('20260912'))) throw new Error('the held Phase 5 migration is back in prisma/migrations — stop');

  prisma(['db', 'push', '--skip-generate'], 'step 1: db push');
  prisma(['db', 'execute', '--file', 'recovery/sql/01-post-push.sql', '--url', url], 'step 2: 01-post-push.sql');
  // Added 2026-09-14 after the first verification: names and kinds db push gets
  // different from the migration history. See the file header.
  prisma(['db', 'execute', '--file', 'recovery/sql/01b-parity.sql', '--url', url], 'step 2b: 01b-parity.sql');
  prisma(['db', 'execute', '--file', 'recovery/sql/02-grants.sql', '--url', url], 'step 3: 02-grants.sql');
  migrations.forEach((name, i) => prisma(['migrate', 'resolve', '--applied', name], `step 4.${i + 1}/48: resolve ${name}`));
  prisma(['migrate', 'status'], 'step 5: migrate status');

  console.log(EXECUTE ? '\nStage 1 steps complete. Now run 11-verify-schema.ts.' : '\nDry run only. Re-run with --execute.');
}

main().catch((e) => {
  console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

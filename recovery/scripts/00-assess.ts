/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 0.3 — read-only assessment of the current database state.
 *
 * STRICTLY READ-ONLY. Every statement in this file is a SELECT. It must never
 * be extended with DDL or DML. Run it before any rebuild decision is executed.
 *
 *   npx tsx recovery/scripts/00-assess.ts
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function head(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql);
}

async function main(): Promise<void> {
  head('CONNECTION');
  const who = await q<{ db: string; usr: string; ver: string }>(
    `SELECT current_database() AS db, current_user AS usr, version() AS ver`,
  );
  console.log(`database : ${who[0].db}`);
  console.log(`user     : ${who[0].usr}`);
  console.log(`server   : ${who[0].ver.split(',')[0]}`);

  head('SCHEMAS PRESENT');
  const schemas = await q<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
     ORDER BY nspname`,
  );
  console.log(schemas.map((s) => s.nspname).join(', '));

  head('PUBLIC TABLES AND LIVE ROW COUNTS');
  const tables = await q<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  if (tables.length === 0) {
    console.log('(no tables in public)');
  } else {
    console.log(`${tables.length} table(s)\n`);
    let nonEmpty = 0;
    for (const t of tables) {
      const rows = await q<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM "public"."${t.tablename}"`);
      const n = Number(rows[0].n);
      if (n > 0) nonEmpty++;
      console.log(`  ${t.tablename.padEnd(42)} ${String(n).padStart(8)}`);
    }
    console.log(`\n${nonEmpty} of ${tables.length} table(s) hold rows.`);
  }

  head('MIGRATION HISTORY');
  const migTable = await q<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations'
     ) AS present`,
  );
  if (!migTable[0].present) {
    console.log('_prisma_migrations : ABSENT — migrate deploy would attempt a full replay.');
  } else {
    const applied = await q<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>(
      `SELECT migration_name, finished_at, rolled_back_at
       FROM "_prisma_migrations" ORDER BY started_at`,
    );
    console.log(`_prisma_migrations : ${applied.length} row(s)`);
    const unfinished = applied.filter((a) => a.finished_at === null || a.rolled_back_at !== null);
    if (unfinished.length) {
      console.log('  UNFINISHED / ROLLED BACK:');
      for (const u of unfinished) console.log(`    ${u.migration_name}`);
    }
    console.log(`  last: ${applied.at(-1)?.migration_name ?? '(none)'}`);
  }

  head('AUTH USERS (survivors — the basis for the public.users backfill)');
  const users = await q<{ id: string; email: string; created_at: Date }>(
    `SELECT id::text, email, created_at FROM auth.users ORDER BY created_at`,
  );
  console.log(`${users.length} user(s)`);
  for (const u of users) {
    console.log(`  ${u.id}  ${String(u.email).padEnd(32)}  ${u.created_at.toISOString().slice(0, 10)}`);
  }

  head('AUTH TRIGGERS (sync into public.users)');
  const trg = await q<{ tgname: string; tgenabled: string }>(
    `SELECT t.tgname, t.tgenabled::text
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'auth' AND c.relname = 'users' AND NOT t.tgisinternal
     ORDER BY t.tgname`,
  );
  console.log(trg.length ? trg.map((t) => `  ${t.tgname} (enabled=${t.tgenabled})`).join('\n') : '  (none — must be recreated in Stage 1)');

  head('STORAGE (screenshots must survive)');
  const buckets = await q<{ id: string; public: boolean }>(`SELECT id, public FROM storage.buckets ORDER BY id`);
  console.log(`buckets: ${buckets.map((b) => `${b.id}${b.public ? ' (public)' : ''}`).join(', ') || '(none)'}`);
  for (const b of buckets) {
    const objs = await q<{ n: bigint }>(
      `SELECT count(*)::bigint AS n FROM storage.objects WHERE bucket_id = '${b.id.replace(/'/g, "''")}'`,
    );
    console.log(`  ${b.id.padEnd(24)} ${String(Number(objs[0].n)).padStart(6)} object(s)`);
  }
  const pol = await q<{ policyname: string }>(
    `SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname`,
  );
  console.log(`storage policies: ${pol.length ? pol.map((p) => p.policyname).join(', ') : '(none)'}`);

  head('PARTIAL / EXPRESSION INDEXES IN PUBLIC (hand-applied SQL, not in schema.prisma)');
  const idx = await q<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND indexdef ILIKE '%WHERE%' ORDER BY indexname`,
  );
  console.log(idx.length ? idx.map((i) => `  ${i.indexname}`).join('\n') : '  (none)');

  head('FUNCTIONS IN PUBLIC');
  const fns = await q<{ proname: string }>(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' ORDER BY p.proname`,
  );
  console.log(fns.length ? '  ' + fns.map((f) => f.proname).join(', ') : '  (none)');

  console.log('\nAssessment complete. No statement in this script modified anything.\n');
}

main()
  .catch((e) => {
    console.error('\nASSESSMENT FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 0.4 — pre-DROP capture.
 *
 * Answers one question before `DROP SCHEMA public CASCADE` runs: what, OUTSIDE
 * `public`, would CASCADE also remove? Also snapshots the schema's grants,
 * default privileges, extensions and function/trigger definitions so Stage 1
 * can restore them faithfully.
 *
 * STRICTLY READ-ONLY against the database. Writes one local JSON file:
 *   recovery/snapshots/predrop-capture.json
 *
 * Exit code 0 = safe to drop. Exit code 2 = do not drop.
 *
 *   npx tsx recovery/scripts/00c-predrop-capture.ts
 */
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const prisma = new PrismaClient({ log: ['warn', 'error'] });
type Row = Record<string, unknown>;

/** The only objects outside `public` that CASCADE is expected to reach: the
 * auth.users sync triggers, whose functions live in public. Stage 1 recreates
 * both. Anything else found reaching into public blocks the drop. */
const EXPECTED_TRIGGERS = ['on_auth_user_created', 'on_auth_user_email_changed'];

async function q(sql: string): Promise<Row[]> {
  const r = await prisma.$queryRawUnsafe<Array<{ j: Row }>>(
    `SELECT row_to_json(x) AS j FROM (${sql}) x`,
  );
  return r.map((z) => z.j);
}

const PUBLIC_REL_OIDS = `
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'`;

const INVENTORY: Record<string, string> = {
  schemaAcl: `
    SELECT nspname, nspowner::regrole::text AS owner, nspacl::text AS acl
    FROM pg_namespace WHERE nspname = 'public'`,
  defaultPrivileges: `
    SELECT d.defaclrole::regrole::text AS role, d.defaclobjtype::text AS objtype, d.defaclacl::text AS acl
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE n.nspname = 'public' ORDER BY 1, 2`,
  extensions: `
    SELECT e.extname, n.nspname AS schema, e.extversion
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1`,
  publicObjectsByKind: `
    SELECT c.relkind::text AS kind, count(*)::int AS n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' GROUP BY 1 ORDER BY 1`,
  publicEnums: `
    SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e' ORDER BY 1`,
  publicFunctions: `
    SELECT p.proname, pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') ORDER BY 1`,
  rlsEnabledTables: `
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity ORDER BY 1`,
  realtimePublication: `
    SELECT pubname, tablename FROM pg_publication_tables
    WHERE schemaname = 'public' ORDER BY 1, 2`,
};

/** Dependency-tracked objects outside public that CASCADE would drop. */
const CASCADE_REACH: Record<string, string> = {
  triggers: `
    SELECT tn.nspname AS table_schema, c.relname AS table_name, t.tgname,
           p.proname AS function_name, pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace tn ON tn.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE NOT t.tgisinternal AND pn.nspname = 'public' AND tn.nspname <> 'public'
    ORDER BY 1, 2, 3`,
  views: `
    SELECT DISTINCT vn.nspname AS view_schema, v.relname AS view_name
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class v ON v.oid = r.ev_class JOIN pg_namespace vn ON vn.oid = v.relnamespace
    JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE d.classid = 'pg_rewrite'::regclass AND tn.nspname = 'public' AND vn.nspname <> 'public'`,
  foreignKeys: `
    SELECT con.conname, con.conrelid::regclass::text AS from_table, con.confrelid::regclass::text AS to_table
    FROM pg_constraint con
    WHERE con.contype = 'f'
      AND con.confrelid IN (${PUBLIC_REL_OIDS})
      AND con.conrelid NOT IN (${PUBLIC_REL_OIDS})`,
  columnsUsingPublicTypes: `
    SELECT n.nspname AS schema, c.relname AS relation, a.attname AS column_name, t.typname AS public_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = t.typnamespace
    WHERE tn.nspname = 'public' AND n.nspname <> 'public' AND a.attnum > 0 AND NOT a.attisdropped`,
  extensionsInPublic: `
    SELECT e.extname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE n.nspname = 'public'`,
};

/** Not dependency-tracked — CASCADE will not drop these, but they would
 * break at runtime until public is rebuilt. Informational. */
const RUNTIME_ONLY: Record<string, string> = {
  policiesMentioningPublic: `
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname <> 'public'
      AND (coalesce(qual, '') ILIKE '%public.%' OR coalesce(with_check, '') ILIKE '%public.%')`,
};

async function main(): Promise<void> {
  const out: Record<string, unknown> = { capturedAt: new Date().toISOString() };

  for (const [k, sql] of Object.entries(INVENTORY)) out[k] = await q(sql);
  const reach: Record<string, Row[]> = {};
  for (const [k, sql] of Object.entries(CASCADE_REACH)) reach[k] = await q(sql);
  out.cascadeReach = reach;
  const runtime: Record<string, Row[]> = {};
  for (const [k, sql] of Object.entries(RUNTIME_ONLY)) runtime[k] = await q(sql);
  out.runtimeOnly = runtime;

  const dir = join(__dirname, '..', 'snapshots');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'predrop-capture.json');
  writeFileSync(file, JSON.stringify(out, null, 2));

  const list = (rows: Row[], f: (r: Row) => string) => (rows.length ? rows.map(f).join(', ') : '(none)');
  const inv = out as Record<string, Row[]>;

  console.log(`\nPRE-DROP CAPTURE  ${out.capturedAt as string}`);
  console.log(`saved → ${file}\n`);
  console.log(`schema owner / acl : ${inv.schemaAcl[0]?.owner} / ${inv.schemaAcl[0]?.acl}`);
  console.log(`default privileges : ${inv.defaultPrivileges.length} entr${inv.defaultPrivileges.length === 1 ? 'y' : 'ies'} (${list(inv.defaultPrivileges, (r) => `${r.role}:${r.objtype}`)})`);
  console.log(`public objects     : ${list(inv.publicObjectsByKind, (r) => `${r.kind}=${r.n}`)}   (r table, i index, S sequence, v view, m matview)`);
  console.log(`public enums       : ${inv.publicEnums.length}`);
  console.log(`public functions   : ${list(inv.publicFunctions, (r) => String(r.proname))}`);
  console.log(`RLS-enabled tables : ${list(inv.rlsEnabledTables, (r) => String(r.relname))}`);
  console.log(`realtime pub rows  : ${inv.realtimePublication.length}`);
  console.log(`extensions         : ${list(inv.extensions, (r) => `${r.extname}@${r.schema}`)}`);

  console.log('\nWHAT CASCADE WOULD REACH OUTSIDE public');
  const blockers: string[] = [];

  const unexpectedTriggers = reach.triggers.filter((t) => !EXPECTED_TRIGGERS.includes(String(t.tgname)));
  const missingTriggers = EXPECTED_TRIGGERS.filter((n) => !reach.triggers.some((t) => t.tgname === n));
  console.log(`  triggers           : ${list(reach.triggers, (r) => `${r.table_schema}.${r.table_name}.${r.tgname}→${r.function_name}`)}`);
  if (unexpectedTriggers.length) blockers.push(`unexpected trigger(s): ${unexpectedTriggers.map((t) => t.tgname).join(', ')}`);
  if (missingTriggers.length) console.log(`  note: expected trigger(s) not present (nothing to lose): ${missingTriggers.join(', ')}`);

  for (const [k, label] of [
    ['views', 'views'],
    ['foreignKeys', 'foreign keys'],
    ['columnsUsingPublicTypes', 'columns on public types'],
    ['extensionsInPublic', 'extensions in public'],
  ] as const) {
    console.log(`  ${label.padEnd(19)}: ${reach[k].length ? JSON.stringify(reach[k]) : '(none)'}`);
    if (reach[k].length) blockers.push(`${label}: ${reach[k].length}`);
  }
  console.log(`  (runtime-only) policies mentioning public: ${runtime.policiesMentioningPublic.length ? JSON.stringify(runtime.policiesMentioningPublic) : '(none)'}`);

  if (blockers.length) {
    console.log(`\nDO NOT DROP. CASCADE reaches beyond the expected auth triggers:\n  - ${blockers.join('\n  - ')}\n`);
    process.exitCode = 2;
  } else {
    console.log(`\nSAFE TO DROP. Outside public, CASCADE reaches only the expected auth trigger(s): ${reach.triggers.map((t) => t.tgname).join(', ') || '(none)'} — recreated in Stage 1.\n`);
  }
}

main()
  .catch((e) => {
    console.error('\nCAPTURE FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

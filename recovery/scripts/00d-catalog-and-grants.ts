/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 0.4b — capture BEFORE the drop, because the evidence disappears with it.
 *
 * 1. Catalog of the current public schema. It was built by the aborted replay
 *    of migrations #1–#37, which makes it a free, partial reference for what the
 *    migration history actually produces. Stage 1 diffs `db push`'s output
 *    against it to show schema.prisma and the migrations agree.
 * 2. Grant posture: which roles can reach public tables, default privileges in
 *    any schema, PostgREST's exposed schemas, and event triggers that fire on
 *    DDL (and could grant on CREATE TABLE).
 *
 * STRICTLY READ-ONLY against the database. Writes one local JSON file:
 *   recovery/snapshots/replay37-catalog.json
 *
 *   npx tsx recovery/scripts/00d-catalog-and-grants.ts
 */
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const prisma = new PrismaClient({ log: ['warn', 'error'] });
type Row = Record<string, unknown>;

async function q(sql: string): Promise<Row[]> {
  const r = await prisma.$queryRawUnsafe<Array<{ j: Row }>>(
    `SELECT row_to_json(x) AS j FROM (${sql}) x`,
  );
  return r.map((z) => z.j);
}

const CATALOG: Record<string, string> = {
  columns: `
    SELECT table_name, column_name, ordinal_position, udt_name, is_nullable,
           column_default, character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position`,
  indexes: `
    SELECT tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' ORDER BY tablename, indexname`,
  constraints: `
    SELECT con.conrelid::regclass::text AS table_name, con.conname, con.contype::text AS type,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
    WHERE n.nspname = 'public' ORDER BY 1, 2`,
  enums: `
    SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY t.typname`,
};

const GRANTS: Record<string, string> = {
  tablePrivilegesByGrantee: `
    SELECT grantee, privilege_type, count(*)::int AS tables
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
    GROUP BY grantee, privilege_type ORDER BY grantee, privilege_type`,
  effectiveAccess: `
    SELECT r.rolname AS role,
           has_schema_privilege(r.rolname, 'public', 'USAGE') AS schema_usage,
           has_table_privilege(r.rolname, 'public.trades', 'SELECT') AS trades_select,
           has_table_privilege(r.rolname, 'public.trades', 'INSERT') AS trades_insert,
           has_table_privilege(r.rolname, 'public.users', 'SELECT') AS users_select
    FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') ORDER BY 1`,
  defaultPrivilegesAllSchemas: `
    SELECT d.defaclrole::regrole::text AS role,
           CASE WHEN d.defaclnamespace = 0 THEN '(all schemas)'
                ELSE d.defaclnamespace::regnamespace::text END AS schema,
           d.defaclobjtype::text AS objtype, d.defaclacl::text AS acl
    FROM pg_default_acl d ORDER BY 1, 2, 3`,
  apiRoles: `
    SELECT rolname, rolconfig FROM pg_roles
    WHERE rolname IN ('authenticator', 'anon', 'authenticated', 'service_role') ORDER BY 1`,
  eventTriggers: `
    SELECT evtname, evtevent, evtfoid::regproc::text AS function_name,
           evtenabled::text AS enabled, evttags
    FROM pg_event_trigger ORDER BY 1`,
};

async function main(): Promise<void> {
  const out: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    note: 'public as left by the aborted replay of migrations #1-#37 (failed at #38)',
  };
  const cat: Record<string, Row[]> = {};
  for (const [k, sql] of Object.entries(CATALOG)) cat[k] = await q(sql);
  const gr: Record<string, Row[]> = {};
  for (const [k, sql] of Object.entries(GRANTS)) gr[k] = await q(sql);
  out.catalog = cat;
  out.grants = gr;

  const dir = join(__dirname, '..', 'snapshots');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'replay37-catalog.json');
  writeFileSync(file, JSON.stringify(out, null, 2));

  const tables = new Set(cat.columns.map((c) => String(c.table_name)));
  console.log(`\nCATALOG + GRANTS  ${out.capturedAt as string}\nsaved → ${file}\n`);
  console.log(
    `catalog : ${tables.size} tables, ${cat.columns.length} columns, ${cat.indexes.length} indexes, ` +
      `${cat.constraints.length} constraints, ${cat.enums.length} enums`,
  );

  console.log('\ntable privileges on public (grantee / privilege / tables):');
  if (!gr.tablePrivilegesByGrantee.length) console.log('  (none)');
  for (const g of gr.tablePrivilegesByGrantee) {
    console.log(`  ${String(g.grantee).padEnd(16)} ${String(g.privilege_type).padEnd(12)} ${g.tables}`);
  }

  console.log('\neffective access:');
  for (const r of gr.effectiveAccess) {
    console.log(
      `  ${String(r.role).padEnd(14)} schema USAGE=${r.schema_usage}  trades SELECT=${r.trades_select} ` +
        `INSERT=${r.trades_insert}  users SELECT=${r.users_select}`,
    );
  }

  console.log('\ndefault privileges (any schema):');
  if (!gr.defaultPrivilegesAllSchemas.length) console.log('  (none)');
  for (const d of gr.defaultPrivilegesAllSchemas) {
    console.log(`  ${String(d.role).padEnd(18)} ${String(d.schema).padEnd(14)} ${d.objtype}  ${d.acl}`);
  }

  console.log('\nAPI roles config:');
  for (const r of gr.apiRoles) console.log(`  ${String(r.rolname).padEnd(14)} ${JSON.stringify(r.rolconfig)}`);

  console.log('\nevent triggers (fire on DDL such as CREATE TABLE):');
  if (!gr.eventTriggers.length) console.log('  (none)');
  for (const e of gr.eventTriggers) {
    console.log(
      `  ${String(e.evtname).padEnd(34)} ${String(e.evtevent).padEnd(18)} ${e.function_name}  ` +
        `enabled=${e.enabled}  tags=${JSON.stringify(e.evttags)}`,
    );
  }

  console.log('\nCapture complete. No statement in this script modified anything.\n');
}

main()
  .catch((e) => {
    console.error('\nCAPTURE FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

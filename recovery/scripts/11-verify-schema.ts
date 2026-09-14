/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 1.3 — prove the rebuilt public schema matches the migration history.
 *
 * Compares the live catalog against recovery/snapshots/replay37-catalog.json —
 * the schema the aborted replay built from migrations #1–#37, captured before
 * the drop with the same queries used here. Every difference must be one the
 * migrations #38–#48 or the hand-applied SQL explain; anything else fails.
 *
 * STRICTLY READ-ONLY. Exit 0 = verified, 2 = unexplained differences.
 *
 *   npx tsx recovery/scripts/11-verify-schema.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });
type Row = Record<string, unknown>;
const q = async (sql: string): Promise<Row[]> =>
  (await prisma.$queryRawUnsafe<Array<{ j: Row }>>(`SELECT row_to_json(x) AS j FROM (${sql}) x`)).map((z) => z.j);

// Same catalog queries as 00d-catalog-and-grants.ts — keep them identical.
const CATALOG = {
  columns: `SELECT table_name, column_name, udt_name, is_nullable, column_default,
                   character_maximum_length, numeric_precision, numeric_scale
            FROM information_schema.columns WHERE table_schema = 'public'`,
  indexes: `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
  constraints: `SELECT con.conrelid::regclass::text AS table_name, con.conname, con.contype::text AS type,
                       pg_get_constraintdef(con.oid) AS definition
                FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
                WHERE n.nspname = 'public'`,
  enums: `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
          FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' GROUP BY t.typname`,
};

/** Tables created by migrations #38–#48. */
const NEW_TABLES = [
  'nse_holidays', 'compass_classifications_archive', 'compass_inputs_archive',
  'compass_module_readings', 'compass_module_states', 'compass_synthesis',
];
/** Columns added to pre-existing tables by #38–#48. */
const NEW_COLUMNS = [
  'nifty_scorecards.is_non_trading_day',
  'compass_classifications.config_version_label', 'compass_classifications.research_tag', 'compass_classifications.is_trading_day',
  'compass_inputs.config_version_label', 'compass_inputs.research_tag', 'compass_inputs.is_trading_day',
  'compass_curve_state.research_tag', 'compass_shock_state.research_tag',
];
/** Index names added (#43, #46, manual-migrations/001) or removed (#46) on pre-existing tables. */
const INDEX_ADDED = [
  'data_points_current_unique', 'compass_classifications_research_tag_idx', 'compass_inputs_research_tag_idx',
  'compass_curve_state_is_validation_research_tag_key', 'compass_shock_state_is_validation_research_tag_key',
  'idx_data_points_current', 'idx_nifty_scorecards_stale', 'idx_edgefinder_scorecards_stale', 'idx_scoring_rules_current',
];
const INDEX_REMOVED = ['compass_curve_state_is_validation_key', 'compass_shock_state_is_validation_key'];
const CONSTRAINT_ADDED = ['compass_curve_state_is_validation_research_tag_key', 'compass_shock_state_is_validation_research_tag_key'];
const CONSTRAINT_REMOVED = ['compass_curve_state_is_validation_key', 'compass_shock_state_is_validation_key'];

async function main(): Promise<void> {
  const ref = JSON.parse(readFileSync(join(__dirname, '..', 'snapshots', 'replay37-catalog.json'), 'utf8')).catalog as Record<string, Row[]>;
  const live: Record<string, Row[]> = {};
  for (const [k, sql] of Object.entries(CATALOG)) live[k] = await q(sql);

  const fails: string[] = [];
  const notes: string[] = [];
  const oldTables = new Set(ref.columns.map((c) => String(c.table_name)));
  const newTables = new Set(live.columns.map((c) => String(c.table_name)));

  // Tables
  // _prisma_migrations did not exist when the reference was captured (the
  // aborted replay ran without it); Stage 1 step 4 creates it by design.
  for (const t of newTables) if (!oldTables.has(t) && !NEW_TABLES.includes(t) && t !== '_prisma_migrations') fails.push(`unexpected table ${t}`);
  for (const t of oldTables) if (!newTables.has(t)) fails.push(`missing table ${t}`);
  for (const t of NEW_TABLES) if (!newTables.has(t)) fails.push(`expected new table ${t} not built`);
  notes.push(`tables: ${oldTables.size} → ${newTables.size}`);

  // Columns on pre-existing tables (ordinal position ignored: ADD COLUMN appends, db push orders by schema)
  const colKey = (c: Row) => `${c.table_name}.${c.column_name}`;
  const colSig = (c: Row) => JSON.stringify([c.udt_name, c.is_nullable, c.column_default, c.character_maximum_length, c.numeric_precision, c.numeric_scale]);
  const refCols = new Map(ref.columns.map((c) => [colKey(c), c]));
  const liveCols = new Map(live.columns.filter((c) => oldTables.has(String(c.table_name))).map((c) => [colKey(c), c]));
  for (const [k, c] of liveCols) {
    const r = refCols.get(k);
    if (!r) { if (!NEW_COLUMNS.includes(k)) fails.push(`unexpected column ${k}`); continue; }
    if (colSig(r) !== colSig(c)) fails.push(`column differs ${k}: replay ${colSig(r)} vs rebuilt ${colSig(c)}`);
  }
  for (const k of refCols.keys()) if (!liveCols.has(k)) fails.push(`missing column ${k}`);
  for (const k of NEW_COLUMNS) if (!liveCols.has(k)) fails.push(`expected new column ${k} not built`);

  // Indexes on pre-existing tables
  const refIdx = new Map(ref.indexes.map((i) => [String(i.indexname), String(i.indexdef)]));
  const liveIdx = new Map(live.indexes.filter((i) => oldTables.has(String(i.tablename))).map((i) => [String(i.indexname), String(i.indexdef)]));
  for (const [name, def] of liveIdx) {
    const r = refIdx.get(name);
    if (r === undefined) { if (!INDEX_ADDED.includes(name)) fails.push(`unexpected index ${name}: ${def}`); continue; }
    if (r !== def) fails.push(`index differs ${name}:\n      replay  ${r}\n      rebuilt ${def}`);
  }
  for (const name of refIdx.keys()) if (!liveIdx.has(name) && !INDEX_REMOVED.includes(name)) fails.push(`missing index ${name}`);
  for (const name of INDEX_ADDED) if (!liveIdx.has(name)) fails.push(`expected index ${name} not present`);

  // Constraints on pre-existing tables
  const conKey = (c: Row) => `${c.table_name}:${c.conname}`;
  const refCon = new Map(ref.constraints.map((c) => [conKey(c), String(c.definition)]));
  const liveCon = new Map(live.constraints.filter((c) => oldTables.has(String(c.table_name))).map((c) => [conKey(c), String(c.definition)]));
  for (const [k, def] of liveCon) {
    const r = refCon.get(k);
    const name = k.split(':')[1];
    if (r === undefined) { if (!CONSTRAINT_ADDED.includes(name)) fails.push(`unexpected constraint ${k}: ${def}`); continue; }
    if (r !== def) fails.push(`constraint differs ${k}: replay ${r} vs rebuilt ${def}`);
  }
  for (const k of refCon.keys()) if (!liveCon.has(k) && !CONSTRAINT_REMOVED.includes(k.split(':')[1])) fails.push(`missing constraint ${k}`);

  // Enums
  const refEnum = new Map(ref.enums.map((e) => [String(e.typname), JSON.stringify(e.labels)]));
  const liveEnum = new Map(live.enums.map((e) => [String(e.typname), JSON.stringify(e.labels)]));
  for (const [n, l] of refEnum) if (liveEnum.get(n) !== l) fails.push(`enum differs ${n}: replay ${l} vs rebuilt ${liveEnum.get(n)}`);
  for (const n of liveEnum.keys()) if (!refEnum.has(n)) fails.push(`unexpected enum ${n}`);

  // New tables (#41, #45, #47, #48) are absent from the reference, so compare
  // them against the migration DDL itself: column names, base types, varchar
  // widths and nullability, plus the index names the migrations created.
  const MIG_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
  const NEW_TABLE_SOURCES: Record<string, string> = {
    nse_holidays: '20260817160000_nse_holiday_calendar',
    compass_classifications_archive: '20260909120000_compass_phase_c_archive_tables',
    compass_inputs_archive: '20260909120000_compass_phase_c_archive_tables',
    compass_module_readings: '20260909140000_compass_phase_c_module_state',
    compass_module_states: '20260909140000_compass_phase_c_module_state',
    compass_synthesis: '20260909140000_compass_phase_c_module_state',
  };
  /** Later ALTERs to the new tables: 20260909150000_compass_widen_source_code. */
  const WIDTH_OVERRIDES: Record<string, number> = { 'compass_module_readings.source_code': 80 };
  const TYPE_MAP: Record<string, string> = {
    TEXT: 'text', VARCHAR: 'varchar', BOOLEAN: 'bool', TIMESTAMP: 'timestamp', TIMESTAMPTZ: 'timestamptz',
    DATE: 'date', INTEGER: 'int4', INT: 'int4', SMALLINT: 'int2', BIGINT: 'int8', DECIMAL: 'numeric',
    NUMERIC: 'numeric', JSONB: 'jsonb', JSON: 'json', 'DOUBLE PRECISION': 'float8', UUID: 'uuid',
  };
  for (const [table, dir] of Object.entries(NEW_TABLE_SOURCES)) {
    const sql = readFileSync(join(MIG_DIR, dir, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
    const block = sql.match(new RegExp(`CREATE TABLE "${table}"\\s*\\(([\\s\\S]*?)\\n\\);`))?.[1];
    if (!block) { fails.push(`cannot find CREATE TABLE "${table}" in ${dir}`); continue; }
    const want = new Map<string, { udt: string; len: number | null; nullable: string }>();
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*"([a-z0-9_]+)"\s+("[^"]+"|[A-Za-z]+(?:\s+PRECISION)?)(?:\((\d+)(?:,\s*\d+)?\))?(\[\])?(.*)$/);
      if (!m) continue;
      const rawType = m[2].replace(/"/g, '');
      const base = TYPE_MAP[rawType.toUpperCase()] ?? rawType;
      const key = `${table}.${m[1]}`;
      want.set(m[1], {
        udt: m[4] ? `_${base}` : base,
        len: WIDTH_OVERRIDES[key] ?? (rawType.toUpperCase() === 'VARCHAR' && m[3] ? Number(m[3]) : null),
        nullable: /NOT NULL|PRIMARY KEY/i.test(m[5]) ? 'NO' : 'YES',
      });
    }
    if (want.size === 0) { fails.push(`parsed no columns for ${table} from ${dir}`); continue; }
    const have = new Map(live.columns.filter((c) => c.table_name === table).map((c) => [String(c.column_name), c]));
    for (const [col, w] of want) {
      const h = have.get(col);
      if (!h) { fails.push(`new table ${table}: missing column ${col}`); continue; }
      const hLen = h.character_maximum_length === null ? null : Number(h.character_maximum_length);
      if (h.udt_name !== w.udt || (w.len !== null && hLen !== w.len) || h.is_nullable !== w.nullable) {
        fails.push(`new table ${table}.${col}: migration ${w.udt}${w.len ? `(${w.len})` : ''} null=${w.nullable} vs rebuilt ${h.udt_name}${hLen ? `(${hLen})` : ''} null=${h.is_nullable}`);
      }
    }
    for (const col of have.keys()) if (!want.has(col)) fails.push(`new table ${table}: unexpected column ${col}`);
  }
  notes.push(`new tables checked against migration DDL: ${Object.keys(NEW_TABLE_SOURCES).length}`);

  const NEW_TABLE_INDEX_NAMES = [
    'compass_classifications_archive_classification_date_idx', 'compass_inputs_archive_observation_date_idx',
    'compass_inputs_archive_input_code_observation_date_idx',
    'compass_module_readings_unique_key', 'compass_module_readings_date_module_idx', 'compass_module_readings_reading_date_idx',
    'compass_module_states_unique_key', 'compass_module_states_date_idx',
    'compass_synthesis_unique_key', 'compass_synthesis_date_idx',
  ];
  const allIdx = new Set(live.indexes.map((i) => String(i.indexname)));
  for (const n of NEW_TABLE_INDEX_NAMES) if (!allIdx.has(n)) fails.push(`migration index name ${n} not present on the new tables`);

  // Hand-applied objects outside the catalog comparison
  const trg = await q(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                       JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'auth' AND c.relname = 'users' AND NOT t.tgisinternal`);
  const trgNames = trg.map((t) => String(t.tgname)).sort();
  if (JSON.stringify(trgNames) !== JSON.stringify(['on_auth_user_created', 'on_auth_user_email_changed'])) {
    fails.push(`auth.users triggers are ${JSON.stringify(trgNames)}, expected exactly on_auth_user_created + on_auth_user_email_changed`);
  }
  const acc = await q(`SELECT r.rolname, has_schema_privilege(r.rolname, 'public', 'USAGE') AS usage
                       FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')`);
  for (const a of acc) if (a.usage) fails.push(`${a.rolname} has USAGE on public — grant posture violated`);

  notes.push(`columns compared: ${liveCols.size}, indexes: ${liveIdx.size}, constraints: ${liveCon.size}, enums: ${liveEnum.size}`);
  console.log(`\nSCHEMA VERIFICATION\n  ${notes.join('\n  ')}`);
  if (fails.length) {
    console.log(`\nUNEXPLAINED DIFFERENCES (${fails.length}):\n  - ${fails.join('\n  - ')}\n`);
    process.exitCode = 2;
  } else {
    console.log('\nVERIFIED: every difference from the #1–#37 replay is explained by migrations #38–#48 or the hand-applied SQL.\n');
  }
}

main()
  .catch((e) => { console.error('\nVERIFY FAILED:', e instanceof Error ? e.message : e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 0.2 — read-only forensics: what has written to the database since the
 * 2026-09-11 ~20:00 UTC reset, and is it still connected?
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT. Never extend with DDL/DML.
 *
 *   npx tsx recovery/scripts/00b-forensics.ts
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const prisma = new PrismaClient({ log: ['warn', 'error'] });
const INCIDENT = new Date('2026-09-11T19:59:00Z');

type Row = Record<string, unknown>;

function head(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

async function rows(sql: string): Promise<Row[]> {
  const r = await prisma.$queryRawUnsafe<Array<{ j: Row }>>(sql);
  return r.map((x) => x.j);
}

/** Prisma writes DateTime into `timestamp without time zone` as UTC, and
 * row_to_json renders those with no offset. `new Date()` would read them as
 * LOCAL time (IST on this machine — a 5h30 shift), so a naive date-time is
 * pinned to UTC explicitly. Date-only strings already parse as UTC. */
const asDate = (v: unknown): Date | null => {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return null;
  const naiveDateTime = /T\d{2}:/.test(v) && !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v);
  const d = new Date(naiveDateTime ? `${v}Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Every timestamp-looking field in a row. */
function stamps(r: Row): Array<[string, Date]> {
  return Object.entries(r)
    .filter(([k]) => /(_at|_date|date)$/i.test(k))
    .map(([k, v]) => [k, asDate(v)] as [string, Date | null])
    .filter((x): x is [string, Date] => x[1] !== null);
}

function range(list: Row[], field: string): string {
  const ds = list.map((r) => asDate(r[field])).filter((d): d is Date => d !== null).sort((a, b) => +a - +b);
  if (!ds.length) return '(no values)';
  return `${ds[0].toISOString()}  →  ${ds.at(-1)!.toISOString()}`;
}

async function main(): Promise<void> {
  const now = new Date();
  console.log(`now (UTC): ${now.toISOString()}   incident: ${INCIDENT.toISOString()}`);

  // ── 1. Live connections right now ─────────────────────────────────────────
  head('1. OTHER SESSIONS CONNECTED RIGHT NOW (pg_stat_activity)');
  const act = await rows(
    `SELECT row_to_json(a) AS j FROM (
       SELECT pid, usename, application_name, client_addr::text, state,
              backend_start, xact_start, state_change,
              left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS query
       FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND backend_type = 'client backend'
       ORDER BY backend_start
     ) a`,
  );
  if (!act.length) console.log('  (no other client sessions)');
  for (const a of act) {
    console.log(
      `  pid ${a.pid}  user=${a.usename}  app=${a.application_name || '-'}  addr=${a.client_addr ?? '-'}  state=${a.state}\n` +
        `    connected ${a.backend_start}   last change ${a.state_change}\n    ${a.query}`,
    );
  }

  // ── 2. data_fetch_log — which jobs ran, how triggered, when ───────────────
  head('2. data_fetch_log — every row (jobs that ran since the reset)');
  const logs = await rows(`SELECT row_to_json(d) AS j FROM data_fetch_log d`);
  const sortKey = (r: Row) => +(stamps(r)[0]?.[1] ?? 0);
  logs.sort((a, b) => sortKey(a) - sortKey(b));
  for (const l of logs) {
    const pick = Object.fromEntries(
      Object.entries(l).filter(([k]) => !/metadata|errors|^id$/i.test(k)),
    );
    console.log('  ' + JSON.stringify(pick));
  }

  // ── 3. calendar_events ────────────────────────────────────────────────────
  head('3. calendar_events — 80 rows');
  const ev = await rows(`SELECT row_to_json(c) AS j FROM calendar_events c`);
  const keys = ev.length ? Object.keys(ev[0]) : [];
  console.log(`  columns: ${keys.join(', ')}`);
  for (const k of keys.filter((k) => /(_at|date)$/i.test(k))) console.log(`  ${k.padEnd(22)} ${range(ev, k)}`);
  const ccy = new Map<string, number>();
  for (const e of ev) {
    const c = String(e.country ?? e.currency ?? '?');
    ccy.set(c, (ccy.get(c) ?? 0) + 1);
  }
  console.log(`  by country: ${[...ccy].map(([c, n]) => `${c}:${n}`).join('  ')}`);

  // ── 4. indicators — the single row ────────────────────────────────────────
  head('4. indicators — the single row');
  for (const r of await rows(
    `SELECT row_to_json(i) AS j FROM (SELECT code, name, tool, data_source, created_at, updated_at FROM indicators) i`,
  )) console.log('  ' + JSON.stringify(r));

  // ── 5. public.users ───────────────────────────────────────────────────────
  head('5. public.users — the single row');
  for (const r of await rows(
    `SELECT row_to_json(u) AS j FROM (SELECT id, email, role, created_at, updated_at FROM users) u`,
  )) console.log('  ' + JSON.stringify(r));

  // ── 6. trading_models / trading_pairs — whose, and when ───────────────────
  head('6. trading_models / trading_pairs — owner and creation time');
  for (const t of ['trading_models', 'trading_pairs']) {
    const list = await rows(
      `SELECT row_to_json(x) AS j FROM (SELECT user_id, created_at FROM ${t}) x`,
    );
    const owners = [...new Set(list.map((r) => String(r.user_id)))];
    console.log(`  ${t.padEnd(16)} ${list.length} rows  owners=${owners.join(',')}  created ${range(list, 'created_at')}`);
  }

  // ── 7. Screenshots: 74 objects vs 69 referenced ───────────────────────────
  head('7. storage objects vs screenshots referenced by the journal dump');
  const objs = await rows(
    `SELECT row_to_json(o) AS j FROM (
       SELECT name, created_at, owner::text AS owner FROM storage.objects
       WHERE bucket_id = 'trade-screenshots' ORDER BY created_at
     ) o`,
  );
  const dump = JSON.parse(
    readFileSync(join(__dirname, '..', 'dumps', 'dtos-after-p4.json'), 'utf8'),
  ) as { trades: Array<{ id: string; screenshots: string[] }> };
  const referenced = dump.trades.flatMap((t) => t.screenshots);
  const isReferenced = (name: string) => referenced.some((s) => s.endsWith(name) || s.includes(name));
  const unref = objs.filter((o) => !isReferenced(String(o.name)));
  const missing = referenced.filter((s) => !objs.some((o) => s.endsWith(String(o.name)) || s.includes(String(o.name))));
  console.log(`  objects in bucket         : ${objs.length}`);
  console.log(`  referenced by the journal : ${referenced.length}`);
  console.log(`  referenced but MISSING    : ${missing.length}`);
  for (const m of missing) console.log(`    MISSING ${m}`);
  console.log(`  in bucket, not referenced : ${unref.length}`);
  for (const u of unref) console.log(`    ${u.created_at}  owner=${u.owner}  ${u.name}`);
  const after = objs.filter((o) => (asDate(o.created_at) ?? new Date(0)) > INCIDENT);
  console.log(`  objects created AFTER the reset: ${after.length}`);

  // ── 8. Latest write anywhere, and is it still going ───────────────────────
  head('8. MOST RECENT WRITE ACROSS THE SURVIVING ROWS');
  const all: Array<[string, Date]> = [];
  for (const [label, list] of [['data_fetch_log', logs], ['calendar_events', ev]] as const) {
    for (const r of list) for (const [k, d] of stamps(r)) if (/created|started|completed|fetched|updated/i.test(k)) all.push([`${label}.${k}`, d]);
  }
  for (const t of ['trading_models', 'trading_pairs', 'users', 'indicators']) {
    const r = await rows(`SELECT row_to_json(x) AS j FROM (SELECT max(created_at) AS created_at FROM ${t}) x`);
    const d = asDate(r[0]?.created_at);
    if (d) all.push([`${t}.created_at`, d]);
  }
  all.sort((a, b) => +b[1] - +a[1]);
  const afterReset = all.filter(([, d]) => d > INCIDENT);
  console.log(`  timestamps after the reset: ${afterReset.length} of ${all.length}`);
  for (const [k, d] of all.slice(0, 8)) {
    const mins = Math.round((+now - +d) / 60000);
    console.log(`  ${d.toISOString()}  (${mins} min ago)  ${k}`);
  }

  console.log('\nForensics complete. No statement in this script modified anything.\n');
}

main()
  .catch((e) => {
    console.error('\nFORENSICS FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 5 — load the hand-collected macro prints into data_points.
 *
 * Source: scripts/data/manual-backfill/*.csv, read from Trading Economics
 * (actual / consensus / previous). Columns:
 *   indicator_code, observation_date (RELEASE date, UTC), release_time_utc,
 *   reference_period, variant, actual, consensus, previous, status, te_url, notes
 *
 * Dry run by default: validates every row against the LIVE registry (so run it
 * after Stage 2), prints anomalies and the Stage 5.4 coverage report, writes
 * nothing. Pass --apply to write, then it verifies what it wrote.
 *
 *   npx tsx recovery/scripts/40-load-manual-backfill.ts            # dry run
 *   npx tsx recovery/scripts/40-load-manual-backfill.ts --apply    # write + verify
 *
 * Mapping: actual → value, consensus → forecastValue, previous → previousValue,
 * source = 'manual', isCurrent = true, one vintage per row. Decimals are passed
 * as strings so nothing is rounded through a float.
 *
 * Latest-print rule: rungs of a ladder are separate rows on their own release
 * dates; every scorer resolves the most recent observationDate <= scoring date,
 * so a later rung can never leak backwards. Ordinal only breaks same-date ties,
 * and several scorers (threshold, cpi_rate_cycle) do NOT apply it — so this
 * loader REFUSES any two rows for one indicator on the same release date.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { validateValue } from '../../src/modules/nifty/services/manual-input.validators';

const ROOT = join(__dirname, '..', '..');
const CSV_DIR = join(ROOT, 'scripts', 'data', 'manual-backfill');
const W_START = '2026-05-26';
const W_END = '2026-09-13';
const APPLY = process.argv.includes('--apply');
const LOADER = 'recovery/scripts/40-load-manual-backfill.ts';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });

interface CsvRow {
  file: string; line: number;
  indicator_code: string; observation_date: string; release_time_utc: string; reference_period: string;
  variant: string; actual: string; consensus: string; previous: string; status: string; te_url: string; notes: string;
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function readCsvs(): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const file of readdirSync(CSV_DIR).filter((f) => f.endsWith('.csv')).sort()) {
    const lines = readFileSync(join(CSV_DIR, file), 'utf8').split(/\r?\n/);
    const header = parseLine(lines[0]);
    lines.slice(1).forEach((l, i) => {
      if (!l.trim()) return;
      const v = parseLine(l);
      const r: Record<string, string> = { file, line: String(i + 2) };
      header.forEach((h, j) => { r[h] = (v[j] ?? '').trim(); });
      rows.push({ ...(r as unknown as CsvRow), line: i + 2 });
    });
  }
  return rows;
}

const isNum = (s: string) => s !== '' && Number.isFinite(Number(s));
const at = (r: CsvRow) => `${r.file}:${r.line} ${r.indicator_code} ${r.observation_date}${r.variant ? ` [${r.variant}]` : ''}`;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const MAX_GAP: Record<string, number> = { daily: 5, weekly: 10, monthly: 45, quarterly: 100 };

interface Ind { id: string; code: string; tool: string; dataSource: string; frequency: string; rungs: string[] }

async function main(): Promise<void> {
  const rows = readCsvs();
  console.log(`Stage 5 manual backfill — ${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} rows from ${CSV_DIR}`);

  const indicators = await prisma.indicator.findMany({
    select: { id: true, code: true, tool: true, dataSource: true, frequency: true, variants: { select: { variant: true, ordinal: true }, orderBy: { ordinal: 'asc' } } },
  });
  if (indicators.length === 0) throw new Error('indicator registry is empty — run Stage 2 first');
  const reg = new Map<string, Ind>(indicators.map((i) => [i.code, {
    id: i.id, code: i.code, tool: i.tool, dataSource: i.dataSource, frequency: i.frequency, rungs: i.variants.map((v) => v.variant),
  }]));

  const errors: string[] = [];
  const warns: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // ── Row validation ────────────────────────────────────────────────────────
  for (const r of rows) {
    const ind = reg.get(r.indicator_code);
    if (!ind) { errors.push(`${at(r)}: unknown indicator code`); continue; }
    if (ind.tool === 'nifty' && ind.dataSource !== 'manual') errors.push(`${at(r)}: NIFTY indicator is data_source=${ind.dataSource}, must be manual (03-config-replay.sql)`);
    if (ind.tool === 'edgefinder' && ind.dataSource === 'fred') errors.push(`${at(r)}: FRED-sourced, manual entry not allowed`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.observation_date) || Number.isNaN(Date.parse(r.observation_date))) errors.push(`${at(r)}: bad observation_date`);
    else if (r.observation_date > today) errors.push(`${at(r)}: observation_date in the future`);
    if (ind.rungs.length > 0 && !r.variant) errors.push(`${at(r)}: ${ind.code} has a ladder (${ind.rungs.join('/')}); variant required`);
    if (ind.rungs.length === 0 && r.variant) errors.push(`${at(r)}: ${ind.code} is single-release; variant "${r.variant}" not allowed`);
    if (ind.rungs.length > 0 && r.variant && !ind.rungs.includes(r.variant)) errors.push(`${at(r)}: "${r.variant}" is not a registered rung (${ind.rungs.join('/')})`);
    if (!isNum(r.actual)) errors.push(`${at(r)}: actual "${r.actual}" is not numeric`);
    for (const c of ['consensus', 'previous'] as const) if (r[c] !== '' && !isNum(r[c])) errors.push(`${at(r)}: ${c} "${r[c]}" is not numeric`);
    const isRate = ind.code.endsWith('_RATE');
    if (ind.tool === 'edgefinder' && isRate && r.consensus === '') errors.push(`${at(r)}: rate decision without an expected rate — rate_decision would return insufficient_data`);
    if (ind.tool === 'edgefinder' && !isRate && r.consensus === '' && r.previous === '') errors.push(`${at(r)}: no consensus and no previous — normal/inverted would return insufficient_data`);
    if (ind.tool === 'edgefinder' && !isRate && r.consensus === '' && r.previous !== '') warns.push(`${at(r)}: no consensus — will score against previous (USED_PREVIOUS_AS_BASELINE)`);
    if (ind.tool === 'nifty' && isNum(r.actual)) {
      const v = validateValue(ind.code, Number(r.actual));
      if (!v.valid) errors.push(`${at(r)}: ${v.reason}`);
    }
    if (r.status !== 'VERIFIED_TE') warns.push(`${at(r)}: status ${r.status} — ${r.notes.slice(0, 120)}`);
  }

  // ── Same-date rows per indicator (tie ambiguity) ──────────────────────────
  const byDate = new Map<string, CsvRow[]>();
  for (const r of rows) {
    const k = `${r.indicator_code}@${r.observation_date}`;
    byDate.set(k, [...(byDate.get(k) ?? []), r]);
  }
  for (const [k, list] of byDate) if (list.length > 1) errors.push(`${k}: ${list.length} rows on one release date (${list.map((x) => x.variant || '-').join(',')}) — ambiguous for scorers without an ordinal tie-break`);

  // ── Revision check (informational) ────────────────────────────────────────
  const byInd = new Map<string, CsvRow[]>();
  for (const r of rows) byInd.set(r.indicator_code, [...(byInd.get(r.indicator_code) ?? []), r]);
  const revisions: string[] = [];
  for (const [code, list] of byInd) {
    const sorted = [...list].sort((a, b) => a.observation_date.localeCompare(b.observation_date));
    sorted.forEach((r, i) => {
      if (r.previous === '') return;
      const prior = sorted.slice(0, i).reverse().find((p) => p.reference_period !== r.reference_period);
      if (prior && isNum(prior.actual) && Number(prior.actual) !== Number(r.previous)) {
        revisions.push(`${code} ${r.observation_date}${r.variant ? ` [${r.variant}]` : ''}: previous ${r.previous} vs prior print ${prior.actual} (${prior.observation_date} ${prior.reference_period})`);
      }
    });
  }

  // ── Coverage (Stage 5.4) ──────────────────────────────────────────────────
  console.log('\nCOVERAGE  (lead-in = a print released on or before W_START; gap = longest stretch without a new print inside the window)');
  const expected = indicators.filter((i) => (i.tool === 'edgefinder' && i.dataSource === 'forex_factory') ||
    ['IND_NIFTY_01_PMI_MFG', 'IND_NIFTY_02_PMI_SVC', 'IND_NIFTY_03_CPI', 'IND_NIFTY_04_RBI_RATE', 'IND_NIFTY_05_IIP'].includes(i.code));
  let covFails = 0;
  for (const ind of expected.sort((a, b) => a.code.localeCompare(b.code))) {
    const list = (byInd.get(ind.code) ?? []).map((r) => r.observation_date).sort();
    const leadIn = list.filter((d) => d <= W_START);
    const inWindow = list.filter((d) => d > W_START && d <= W_END);
    const points = [leadIn.at(-1) ?? W_START, ...inWindow, W_END];
    let gap = 0;
    for (let i = 1; i < points.length; i++) gap = Math.max(gap, days(points[i - 1], points[i]));
    const limit = MAX_GAP[ind.frequency];
    const problems: string[] = [];
    if (!list.length) problems.push('NO ROWS');
    else if (!leadIn.length) problems.push(`no lead-in (first ${list[0]})`);
    if (limit && gap > limit) problems.push(`gap ${gap}d > ${limit}d`);
    if (problems.length) covFails++;
    console.log(`  ${problems.length ? 'FAIL' : 'ok  '} ${ind.code.padEnd(24)} ${ind.frequency.padEnd(12)} rows ${String(list.length).padStart(2)}  lead-in ${leadIn.at(-1) ?? '—'}  in-window ${String(inWindow.length).padStart(2)}  max gap ${gap}d${problems.length ? `  ← ${problems.join('; ')}` : ''}`);
  }
  if (covFails) errors.push(`${covFails} indicator(s) fail coverage`);

  const statusMix = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  console.log(`\nstatus: ${Object.entries(statusMix).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`\nWARNINGS (${warns.length})`); warns.forEach((w) => console.log(`  ${w}`));
  console.log(`\nREVISIONS — previous differs from the prior print on file (${revisions.length}; informational: source revisions or rung differences)`);
  revisions.slice(0, 40).forEach((w) => console.log(`  ${w}`));
  if (revisions.length > 40) console.log(`  … ${revisions.length - 40} more`);

  if (errors.length) {
    console.log(`\nERRORS (${errors.length}) — nothing written`); errors.forEach((e) => console.log(`  ${e}`));
    process.exitCode = 2;
    return;
  }
  console.log('\nVALIDATION PASSED');
  if (!APPLY) { console.log('Dry run only. Re-run with --apply.'); return; }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const ids = [...new Set(rows.map((r) => reg.get(r.indicator_code)!.id))];
  const existing = await prisma.dataPoint.findMany({ where: { indicatorId: { in: ids }, isCurrent: true } });
  const key = (indicatorId: string, date: string, variant: string | null) => `${indicatorId}|${date}|${variant ?? ''}`;
  const existingByKey = new Map(existing.map((d) => [key(d.indicatorId, d.observationDate.toISOString().slice(0, 10), d.variant), d]));
  const same = (a: unknown, b: string) => (a === null ? b === '' : b !== '' && Number(a) === Number(b));

  const toCreate: Prisma.DataPointCreateManyInput[] = [];
  let skipped = 0;
  const conflicts: string[] = [];
  for (const r of rows) {
    const ind = reg.get(r.indicator_code)!;
    const ex = existingByKey.get(key(ind.id, r.observation_date, r.variant || null));
    if (ex) {
      if (same(ex.value, r.actual) && same(ex.forecastValue, r.consensus) && same(ex.previousValue, r.previous)) { skipped++; continue; }
      conflicts.push(`${at(r)}: a different current row exists (value ${ex.value}, forecast ${ex.forecastValue}, previous ${ex.previousValue})`);
      continue;
    }
    toCreate.push({
      indicatorId: ind.id,
      observationDate: new Date(`${r.observation_date}T00:00:00.000Z`),
      variant: r.variant || null,
      value: r.actual,
      forecastValue: r.consensus === '' ? null : r.consensus,
      previousValue: r.previous === '' ? null : r.previous,
      source: 'manual',
      isCurrent: true,
      notes: r.notes || null,
      createdBy: 'recovery-stage5',
      sourceMetadata: {
        loader: LOADER, csv: r.file, csvLine: r.line, status: r.status, te_url: r.te_url,
        reference_period: r.reference_period, release_time_utc: r.release_time_utc,
      },
    });
  }
  if (conflicts.length) {
    console.log(`\nCONFLICTS (${conflicts.length}) — nothing written`); conflicts.forEach((c) => console.log(`  ${c}`));
    process.exitCode = 2;
    return;
  }
  const written = await prisma.$transaction(async (tx) => (await tx.dataPoint.createMany({ data: toCreate })).count, { timeout: 120_000 });
  console.log(`\nwritten ${written}, already present ${skipped}`);

  // ── Verify ────────────────────────────────────────────────────────────────
  const after = await prisma.dataPoint.findMany({ where: { indicatorId: { in: ids }, isCurrent: true, source: 'manual' } });
  const afterByKey = new Map(after.map((d) => [key(d.indicatorId, d.observationDate.toISOString().slice(0, 10), d.variant), d]));
  let bad = 0;
  for (const r of rows) {
    const d = afterByKey.get(key(reg.get(r.indicator_code)!.id, r.observation_date, r.variant || null));
    if (!d || !same(d.value, r.actual) || !same(d.forecastValue, r.consensus) || !same(d.previousValue, r.previous)) { bad++; console.log(`  MISMATCH ${at(r)}`); }
  }
  console.log(bad === 0 ? `VERIFIED: all ${rows.length} rows present with identical actual / consensus / previous` : `NOT VERIFIED: ${bad} mismatch(es)`);
  if (bad) process.exitCode = 2;
}

main()
  .catch((e) => { console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

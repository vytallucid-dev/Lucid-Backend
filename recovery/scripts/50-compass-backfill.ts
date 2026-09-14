/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 6 — Compass history for the window, in live space.
 *
 * Three phases, each explicit:
 *
 *   --backfill  Run the shipped historical backfill (backfillWindow) over
 *               BACKFILL_START → W_END. It writes VALIDATION-space rows
 *               (isValidation = true), the only mode in which every input
 *               service is point-in-time: it anchors fetches to the observation
 *               date and filters out later data (US data stack uses ALFRED
 *               vintages). Oracle never reads validation space.
 *
 *   --classify  Re-run ONLY the classifier over every US trading day, oldest
 *               first, in validation space, after resetting validation-space
 *               classifier output and state caches in range. Needed because
 *               config v1 (effective to 2026-07-15) predates the Shock Layer —
 *               it carries the retired `crisisOverride` instead of `shockLayer`
 *               — and the current classifier reads shockLayer unconditionally,
 *               so every v1 date failed in --backfill (inputs were fine). The
 *               recovery process fills a missing shockLayer with a DISABLED one
 *               (Trigger A needs VIX > +∞; Trigger B needs USDJPY move < −∞), so
 *               neither trigger can fire: those dates classify as they did before
 *               the Shock Layer existed. The retired crisis clause (VIX > 30 AND
 *               HY OAS > 7.0) is not reproduced; it requires crisis-level spreads.
 *               v2/v3 dates carry their own shockLayer and are untouched.
 *
 *   --promote   Copy the validation rows into LIVE space (isValidation = false)
 *               for the window, in one transaction: compass_inputs,
 *               compass_classifications, module readings/states, synthesis, and
 *               the curve/shock state caches. Columns are discovered at runtime.
 *               compass_classifications is unique on (classification_date,
 *               vintage_date) WITHOUT is_validation, so the live copy shifts
 *               vintage_date by 1 ms. Refuses if live rows already exist in range.
 *
 * No flag = dry run: prints the plan.
 *
 * Call budget. EODHD is on the free plan (20 calls/day). The live input services
 * call it per day; here eodhdClient.fetchEodSeries is memoized so each symbol is
 * fetched once. FRED calls WITHOUT a vintage are memoized the same way
 * (identical semantics: latest vintage); calls WITH asOfDate go through
 * unchanged, because each day needs its own vintage. All patches live in this
 * process only; production code is untouched.
 *
 *   npx tsx recovery/scripts/50-compass-backfill.ts --backfill | --classify | --promote
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { eodhdClient } from '../../src/core/clients/eodhd/eodhd.client';
import type { EodhdDataPoint } from '../../src/core/clients/eodhd/types';
import {
  compassFredClient,
  type CompassFredObservation,
} from '../../src/core/clients/fred/compass-fred.client';
import { compassConfigRepository } from '../../src/core/repositories/compass-config.repository';
import { generateTradingDays } from '../../src/core/utils/us-market-calendar';
import { backfillWindow } from '../../src/modules/edgefinder/services/compass/validation/historical-backfill.service';
import { runCompassClassifier } from '../../src/modules/edgefinder/services/compass/compass-classifier.service';

const W_START = '2026-05-26';
const W_END = '2026-09-13';
/** Classifier reads 45 calendar days of stored inputs (US02Y_HISTORY_DAYS_BACK). */
const BACKFILL_START = '2026-04-11';
/** EODHD pre-warm: well before any input's own DAYS_BACK from BACKFILL_START. */
const EOD_PREWARM_FROM = '2025-12-01';
const EOD_SYMBOLS = ['VIX.INDX', 'VIX3M.INDX', 'DXY.INDX', 'USDJPY.FOREX'];

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });

// ── Memoization (this process only) ─────────────────────────────────────────
const calls = { eodhd: 0, fredLatest: 0, fredVintage: 0, eodMemoHits: 0, fredMemoHits: 0 };

function installMemo(): void {
  const realEod = eodhdClient.fetchEodSeries.bind(eodhdClient);
  const eodMemo = new Map<string, { from: string; rows: EodhdDataPoint[] }>();
  eodhdClient.fetchEodSeries = async (symbol: string, from?: string): Promise<EodhdDataPoint[]> => {
    const m = eodMemo.get(symbol);
    if (m && from && from >= m.from) {
      calls.eodMemoHits++;
      return m.rows.filter((r) => r.date >= from);
    }
    const effectiveFrom = from && from < EOD_PREWARM_FROM ? from : EOD_PREWARM_FROM;
    calls.eodhd++;
    const rows = await realEod(symbol, effectiveFrom);
    eodMemo.set(symbol, { from: effectiveFrom, rows });
    return from ? rows.filter((r) => r.date >= from) : rows;
  };

  const realRange = compassFredClient.fetchSeriesByDateRange.bind(compassFredClient);
  const fredMemo = new Map<string, { start: number; end: number; rows: CompassFredObservation[] }>();
  const slice = (rows: CompassFredObservation[], s: Date, e: Date) =>
    rows.filter((o) => o.date.getTime() >= s.getTime() && o.date.getTime() <= e.getTime());
  compassFredClient.fetchSeriesByDateRange = async (seriesId, startDate, endDate, asOfDate) => {
    if (asOfDate) {
      calls.fredVintage++;
      return realRange(seriesId, startDate, endDate, asOfDate);
    }
    const m = fredMemo.get(seriesId);
    if (m && startDate.getTime() >= m.start && endDate.getTime() <= m.end) {
      calls.fredMemoHits++;
      return slice(m.rows, startDate, endDate);
    }
    const start = Math.min(startDate.getTime(), m?.start ?? Number.POSITIVE_INFINITY, day('2024-01-01').getTime());
    const end = Math.max(endDate.getTime(), m?.end ?? 0, day(W_END).getTime());
    calls.fredLatest++;
    const rows = await realRange(seriesId, new Date(start), new Date(end));
    fredMemo.set(seriesId, { start, end, rows });
    return slice(rows, startDate, endDate);
  };
}

// ── Config patch: a disabled Shock Layer where the config predates it ────────
const DISABLED_SHOCK_LAYER = {
  shock_a_vix_threshold: Number.POSITIVE_INFINITY, // Trigger A: vixClose > threshold — never
  shock_a_oas_delta5: Number.POSITIVE_INFINITY,
  shock_b_usdjpy_move5: Number.NEGATIVE_INFINITY, // Trigger B: move5 < threshold — never
  shock_expiry_trading_days: 10,
};
const patchedVersions = new Set<string>();

function installConfigPatch(): void {
  const real = compassConfigRepository.resolveForDate.bind(compassConfigRepository);
  compassConfigRepository.resolveForDate = async (date: Date) => {
    const cfg = await real(date);
    if (!cfg.shockLayer) {
      patchedVersions.add(String(cfg.versionLabel));
      return { ...cfg, shockLayer: { ...DISABLED_SHOCK_LAYER } };
    }
    return cfg;
  };
}

// ── Backfill ────────────────────────────────────────────────────────────────
async function runBackfill(): Promise<void> {
  installMemo();
  installConfigPatch();
  console.log(`backfill ${BACKFILL_START} → ${W_END} (validation space). Pre-warming ${EOD_SYMBOLS.length} EODHD symbols…`);
  for (const s of EOD_SYMBOLS) {
    const rows = await eodhdClient.fetchEodSeries(s, EOD_PREWARM_FROM);
    console.log(`  ${s}: ${rows.length} rows ${rows[0]?.date ?? '-'} → ${rows.at(-1)?.date ?? '-'}`);
  }
  const started = Date.now();
  const result = await backfillWindow({ windowName: 'recovery-2026-09', startDate: day(BACKFILL_START), endDate: day(W_END) }, 'recovery');
  console.log(`\nbackfill finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
  console.log(`calls: ${JSON.stringify(calls)}; shockLayer disabled for config version(s): ${[...patchedVersions].join(', ') || 'none'}`);
}

// ── Classify only ───────────────────────────────────────────────────────────
async function runClassify(): Promise<void> {
  const running = await prisma.dataFetchLog.count({ where: { jobName: 'compass_validation_backfill', status: 'running' } });
  if (running > 0) throw new Error('compass_validation_backfill is still running — wait for it to finish');

  installMemo();
  installConfigPatch();
  const range = { gte: day(BACKFILL_START), lte: day(W_END) };
  const days = generateTradingDays(day(BACKFILL_START), day(W_END));

  const inputRows = await prisma.compassInput.findMany({ where: { isValidation: true, observationDate: range }, select: { observationDate: true, inputCode: true } });
  const codesByDay = new Map<string, Set<string>>();
  for (const r of inputRows) {
    const k = iso(r.observationDate);
    (codesByDay.get(k) ?? codesByDay.set(k, new Set()).get(k)!).add(r.inputCode);
  }
  const allCodes = new Set(inputRows.map((r) => r.inputCode));
  const thin = days.map(iso).filter((d) => (codesByDay.get(d)?.size ?? 0) < allCodes.size);
  console.log(`inputs: ${inputRows.length} rows, ${allCodes.size} codes (${[...allCodes].sort().join(', ')}); trading days ${days.length}; days missing an input: ${thin.length}${thin.length ? ` (${thin.slice(0, 10).join(' ')})` : ''}`);

  const reset = await prisma.$transaction([
    prisma.compassClassification.deleteMany({ where: { isValidation: true, classificationDate: range } }),
    prisma.compassModuleReading.deleteMany({ where: { isValidation: true, classificationDate: range } }),
    prisma.compassModuleState.deleteMany({ where: { isValidation: true, classificationDate: range } }),
    prisma.compassSynthesis.deleteMany({ where: { isValidation: true, classificationDate: range } }),
    prisma.compassCurveState.deleteMany({ where: { isValidation: true } }),
    prisma.compassShockState.deleteMany({ where: { isValidation: true } }),
  ]);
  console.log(`reset validation-space classifier output: ${reset.map((r) => r.count).join(' / ')} (classifications / readings / states / synthesis / curve / shock)`);

  const tally: Record<string, number> = {};
  const failures: string[] = [];
  for (const [i, d] of days.entries()) {
    const r = (await runCompassClassifier('manual', 'recovery', d, true)) as unknown as Record<string, unknown>;
    const status = String(r.status ?? 'unknown');
    tally[status] = (tally[status] ?? 0) + 1;
    if (status === 'failed') failures.push(`${iso(d)} ${JSON.stringify(r).slice(0, 240)}`);
    if ((i + 1) % 20 === 0 || i === days.length - 1) console.log(`  ${i + 1}/${days.length} ${iso(d)} ${JSON.stringify(tally)}`);
  }

  const have = new Set((await prisma.compassClassification.findMany({
    where: { isValidation: true, isCurrent: true, classificationDate: range }, select: { classificationDate: true },
  })).map((c) => iso(c.classificationDate)));
  const missing = days.map(iso).filter((d) => !have.has(d));
  const inWindowMissing = missing.filter((d) => d >= W_START);
  const regimes = await prisma.compassClassification.groupBy({
    by: ['finalRegime'], where: { isValidation: true, isCurrent: true, classificationDate: { gte: day(W_START), lte: day(W_END) } }, _count: { _all: true },
  });
  console.log(`\nfailures ${failures.length}`);
  failures.slice(0, 15).forEach((f) => console.log(`  ${f}`));
  console.log(`shockLayer disabled for config version(s): ${[...patchedVersions].join(', ') || 'none'}; calls ${JSON.stringify(calls)}`);
  console.log(`window regimes: ${regimes.map((g) => `${g.finalRegime}=${g._count._all}`).join('  ')}`);
  const ok = inWindowMissing.length === 0;
  console.log(`${ok ? 'CLASSIFICATION VERIFIED' : 'CLASSIFICATION NOT VERIFIED'}: ${have.size}/${days.length} trading days classified; missing in window ${inWindowMissing.length}${missing.length ? ` (all missing: ${missing.slice(0, 12).join(' ')})` : ''}`);
  if (!ok) process.exitCode = 2;
}

// ── Promote validation → live ───────────────────────────────────────────────
interface Col { column_name: string; udt_name: string }

async function columns(table: string): Promise<Col[]> {
  return prisma.$queryRawUnsafe<Col[]>(
    `SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    table,
  );
}

function selectList(cols: Col[], opts: { shiftVintage?: boolean }): { insertCols: string; selectExprs: string } {
  const insertCols = cols.map((c) => `"${c.column_name}"`).join(', ');
  const selectExprs = cols
    .map((c) => {
      if (c.column_name === 'id') return c.udt_name === 'uuid' ? 'gen_random_uuid()' : 'gen_random_uuid()::text';
      if (c.column_name === 'is_validation') return 'false';
      if (opts.shiftVintage && c.column_name === 'vintage_date') return `"vintage_date" + interval '1 millisecond'`;
      return `"${c.column_name}"`;
    })
    .join(', ');
  return { insertCols, selectExprs };
}

async function runPromote(): Promise<void> {
  const RANGED: Array<{ table: string; dateCol: string; shiftVintage?: boolean }> = [
    { table: 'compass_inputs', dateCol: 'observation_date' },
    { table: 'compass_classifications', dateCol: 'classification_date', shiftVintage: true },
    { table: 'compass_module_readings', dateCol: 'classification_date' },
    { table: 'compass_module_states', dateCol: 'classification_date' },
    { table: 'compass_synthesis', dateCol: 'classification_date' },
  ];
  const STATE = ['compass_curve_state', 'compass_shock_state'];

  for (const r of RANGED) {
    const [c] = await prisma.$queryRawUnsafe<Array<{ v: bigint; l: bigint }>>(
      `SELECT count(*) FILTER (WHERE is_validation) AS v, count(*) FILTER (WHERE NOT is_validation) AS l
       FROM "${r.table}" WHERE "${r.dateCol}" BETWEEN $1::date AND $2::date`,
      BACKFILL_START, W_END,
    );
    console.log(`  ${r.table.padEnd(26)} validation ${String(c.v).padStart(5)}   live ${String(c.l).padStart(5)}`);
    if (Number(c.l) > 0) throw new Error(`${r.table} already has live rows in range — refusing to promote over them`);
  }
  const [cls] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM compass_classifications WHERE is_validation AND classification_date BETWEEN $1::date AND $2::date`,
    W_START, W_END,
  );
  if (Number(cls.n) === 0) throw new Error('no validation classifications inside the window — run --classify first');

  await prisma.$transaction(async (tx) => {
    for (const r of RANGED) {
      const { insertCols, selectExprs } = selectList(await columns(r.table), { shiftVintage: r.shiftVintage });
      const n = await tx.$executeRawUnsafe(
        `INSERT INTO "${r.table}" (${insertCols}) SELECT ${selectExprs} FROM "${r.table}"
         WHERE is_validation AND "${r.dateCol}" BETWEEN $1::date AND $2::date`,
        BACKFILL_START, W_END,
      );
      console.log(`  promoted ${String(n).padStart(5)} → ${r.table}`);
    }
    for (const t of STATE) {
      const { insertCols, selectExprs } = selectList(await columns(t), {});
      await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE NOT is_validation AND research_tag = ''`);
      const n = await tx.$executeRawUnsafe(
        `INSERT INTO "${t}" (${insertCols}) SELECT ${selectExprs} FROM "${t}" WHERE is_validation AND research_tag = ''`,
      );
      console.log(`  promoted ${String(n).padStart(5)} → ${t}`);
    }
  }, { timeout: 300_000, maxWait: 20_000 });

  const [v] = await prisma.$queryRawUnsafe<Array<{ val: bigint; live: bigint; first: string | null; last: string | null }>>(
    `SELECT count(*) FILTER (WHERE is_validation) AS val, count(*) FILTER (WHERE NOT is_validation) AS live,
            min(classification_date) FILTER (WHERE NOT is_validation)::text AS first,
            max(classification_date) FILTER (WHERE NOT is_validation)::text AS last
     FROM compass_classifications WHERE classification_date BETWEEN $1::date AND $2::date AND is_current`,
    BACKFILL_START, W_END,
  );
  const gate = async (d: string) => prisma.compassClassification.findFirst({
    where: { isCurrent: true, isValidation: false, classificationDate: { lte: day(d) } },
    orderBy: { classificationDate: 'desc' },
    select: { classificationDate: true, finalRegime: true },
  });
  const gs = await gate(W_START);
  const ge = await gate(W_END);
  const ok = Number(v.val) === Number(v.live) && !!gs && !!ge;
  console.log(`\n${ok ? 'PROMOTION VERIFIED' : 'PROMOTION NOT VERIFIED'}: current classifications validation ${v.val} = live ${v.live} (${v.first} → ${v.last});` +
    ` live regime gate at ${W_START}: ${gs ? `${iso(gs.classificationDate)} ${gs.finalRegime}` : 'NONE'};` +
    ` at ${W_END}: ${ge ? `${iso(ge.classificationDate)} ${ge.finalRegime}` : 'NONE'}`);
  if (!ok) process.exitCode = 2;
}

async function main(): Promise<void> {
  const mode = ['backfill', 'classify', 'promote'].find((m) => process.argv.includes(`--${m}`)) ?? 'dry';
  console.log(`Stage 6 Compass — ${mode.toUpperCase()} — window ${W_START} → ${W_END}, backfill from ${BACKFILL_START}`);
  if (mode === 'dry') {
    console.log('Plan: --backfill (inputs + classifier, validation space) → --classify (classifier only, disabled Shock Layer where config predates it) → --promote (copy to live).');
    return;
  }
  if (mode === 'backfill') await runBackfill();
  else if (mode === 'classify') await runClassify();
  else await runPromote();
}

main()
  .catch((e) => { console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

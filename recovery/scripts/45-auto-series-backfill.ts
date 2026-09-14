/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 4 — auto-fetched series that the NIFTY and Oracle replays read.
 *
 * Every step reuses the shipped fetch path where one exists, so values land
 * exactly as the cron would have written them. Where the shipped service can
 * only fetch "today", the recovery writes history through the same
 * dataPointsRepository.upsert with the same source/metadata shape, marked
 * `recovery: true`.
 *
 *   npx tsx recovery/scripts/45-auto-series-backfill.ts                 # plan only
 *   npx tsx recovery/scripts/45-auto-series-backfill.ts --step=eodhd    # one step
 *   npx tsx recovery/scripts/45-auto-series-backfill.ts --step=all
 *
 * Steps:
 *   eodhd  DXY from 2026-04-23 — production's DXY history began then (migration
 *          20260817150000's note: ~82 observations by 2026-08-17), and the v3
 *          slope-sigma estimate depends on depth; USDINR from 12 months back
 *          (EODHD free plan's history limit). 2 API calls.
 *   fred   US_02Y_SMA via the shipped FRED path (raw DGS2 + 21-day SMA).
 *   brent  IND_NIFTY_11_BRENT: Yahoo BZ=F daily history. The shipped service
 *          persists only the latest close; history is written row by row with
 *          previous-value chaining.
 *   vix    IND_NIFTY_08_VIX: NSE's allIndices endpoint is live-only. History
 *          from Yahoo ^INDIAVIX (the same index close), marked as a history
 *          substitute in sourceMetadata.
 *   poi    IND_NIFTY_13_FII_LS_RATIO: the shipped single-date archive scrape,
 *          once per NSE trading day from --poi-from (default 2025-06-02).
 *   cftc   COT via the shipped service, daysBack 150 (needs the row-limit fix).
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { fetchEodhdIndicator } from '../../src/modules/nifty/services/eodhd-indicator.service';
import { fetchFredIndicator } from '../../src/modules/nifty/services/fred-indicator.service';
import { scrapeNseParticipantOi } from '../../src/modules/nifty/services/nse-participant-oi.service';
import { fetchCftcCotData } from '../../src/modules/edgefinder/services/cftc-cot-indicator.service';
import { yahooClient } from '../../src/core/clients/yahoo/yahoo.client';
import { dataPointsRepository } from '../../src/core/repositories/data-points.repository';
import { dataFetchLogRepository } from '../../src/core/repositories/data-fetch-log.repository';

const W_END = '2026-09-13';
const DXY_FROM = '2026-04-23';
const USDINR_FROM = '2025-09-15';
const US02Y_FROM = '2025-06-01';
const BRENT_FROM = '2025-06-01';
const VIX_FROM = '2026-04-01';
const POI_FROM_DEFAULT = '2025-06-02';
const CFTC_DAYS_BACK = 150;

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });

async function stepEodhd(): Promise<void> {
  for (const [code, from] of [['IND_NIFTY_10_DXY', DXY_FROM], ['IND_NIFTY_12_USDINR', USDINR_FROM]] as const) {
    const r = await fetchEodhdIndicator({ indicatorCode: code, dateFrom: day(from), dateTo: day(W_END), triggerType: 'backfill', triggeredBy: 'recovery' });
    console.log(`  ${code}: ${r.status} received ${r.observationsReceived} inserted ${r.rowsInserted} updated ${r.rowsUpdated} skipped ${r.rowsSkipped} (${r.dateFrom} → ${r.dateTo})`);
    if (r.status === 'failed') throw new Error(`${code} failed: ${JSON.stringify(r.errors).slice(0, 300)}`);
  }
}

async function stepFred(): Promise<void> {
  const r = await fetchFredIndicator({ indicatorCode: 'US_02Y_SMA', dateFrom: day(US02Y_FROM), dateTo: day(W_END), triggerType: 'backfill', triggeredBy: 'recovery' });
  console.log(`  US_02Y_SMA: ${r.status} inserted ${r.rowsInserted} updated ${r.rowsUpdated} skipped ${r.rowsSkipped}`);
  if (r.status === 'failed') throw new Error('US_02Y_SMA failed');
}

async function writeDailyHistory(opts: {
  indicatorCode: string; symbol: string; from: string; jobName: string;
  source: 'yahoo'; metadata: Record<string, unknown>;
}): Promise<void> {
  const ind = await prisma.indicator.findUniqueOrThrow({ where: { code: opts.indicatorCode } });
  const daysBack = Math.ceil((Date.now() - day(opts.from).getTime()) / 864e5) + 5;
  const rows = (await yahooClient.fetchDailyHistory({ symbol: opts.symbol, daysBack }))
    .filter((r) => r.date >= opts.from && r.date <= W_END && r.close !== null && Number.isFinite(r.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  const log = await dataFetchLogRepository.start({
    jobName: opts.jobName, triggerType: 'backfill', triggeredBy: 'recovery',
    targetDateFrom: day(opts.from), targetDateTo: day(W_END),
    metadata: { indicatorCode: ind.code, provider: 'yahoo', symbol: opts.symbol, recovery: true },
  });
  let inserted = 0; let updated = 0; let skipped = 0;
  let previous: number | null = null;
  for (const r of rows) {
    const res = await dataPointsRepository.upsert({
      indicatorId: ind.id, observationDate: day(r.date), value: r.close, forecastValue: null, previousValue: previous,
      source: opts.source, sourceMetadata: { ...opts.metadata, symbol: opts.symbol, recovery: true }, fetchedVia: log.id,
    });
    if (res.action === 'inserted') inserted++; else if (res.action === 'revised') updated++; else skipped++;
    previous = r.close;
  }
  await dataFetchLogRepository.complete({ logId: log.id, status: 'success', rowsInserted: inserted, rowsUpdated: updated, rowsSkipped: skipped });
  console.log(`  ${ind.code}: ${rows.length} closes ${rows[0]?.date ?? '-'} → ${rows.at(-1)?.date ?? '-'}; inserted ${inserted} updated ${updated} skipped ${skipped}`);
}

async function stepBrent(): Promise<void> {
  await writeDailyHistory({
    indicatorCode: 'IND_NIFTY_11_BRENT', symbol: 'BZ=F', from: BRENT_FROM, jobName: 'recovery_yahoo_brent_history',
    source: 'yahoo', metadata: { provider: 'yahoo', instrument: 'brent_futures' },
  });
}

async function stepVix(): Promise<void> {
  await writeDailyHistory({
    indicatorCode: 'IND_NIFTY_08_VIX', symbol: '^INDIAVIX', from: VIX_FROM, jobName: 'recovery_india_vix_history',
    source: 'yahoo',
    metadata: { provider: 'yahoo', index: 'INDIA VIX', historySubstituteFor: 'nse_scrape /api/allIndices (live-only, no history)' },
  });
}

async function nseTradingDays(from: string, to: string): Promise<Date[]> {
  const holidays = new Set((await prisma.nseHoliday.findMany({ select: { date: true } })).map((h) => iso(h.date)));
  const out: Date[] = [];
  for (let d = day(from); d <= day(to); d = new Date(d.getTime() + 864e5)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !holidays.has(iso(d))) out.push(d);
  }
  return out;
}

async function stepPoi(): Promise<void> {
  const from = arg('poi-from') ?? POI_FROM_DEFAULT;
  const days = await nseTradingDays(from, W_END);
  console.log(`  participant OI: ${days.length} NSE trading days ${from} → ${W_END}`);
  const tally: Record<string, number> = {};
  const problems: string[] = [];
  for (const [i, d] of days.entries()) {
    const r = await scrapeNseParticipantOi({ triggerType: 'manual', triggeredBy: 'recovery', observationDate: d });
    for (const det of r.details) {
      tally[det.outcome] = (tally[det.outcome] ?? 0) + 1;
      if (!['inserted', 'revised', 'skipped'].includes(det.outcome)) problems.push(`${det.date} ${det.outcome}${det.error ? ` ${det.error}` : ''}`);
    }
    if ((i + 1) % 25 === 0) console.log(`    ${i + 1}/${days.length} ${iso(d)} ${JSON.stringify(tally)}`);
    await sleep(1200);
  }
  console.log(`  participant OI done: ${JSON.stringify(tally)}`);
  problems.slice(0, 30).forEach((p) => console.log(`    ${p}`));
  if (problems.length > 30) console.log(`    … ${problems.length - 30} more`);
}

async function stepCftc(): Promise<void> {
  const r = await fetchCftcCotData('backfill', 'recovery', { daysBack: CFTC_DAYS_BACK });
  console.log(`  COT: ${JSON.stringify(r).slice(0, 600)}`);
}

const STEPS: Record<string, () => Promise<void>> = { eodhd: stepEodhd, fred: stepFred, brent: stepBrent, vix: stepVix, poi: stepPoi, cftc: stepCftc };

async function main(): Promise<void> {
  const step = arg('step');
  if (!step) {
    console.log(`Stage 4 plan (no --step given, nothing run): ${Object.keys(STEPS).join(', ')}. See the file header.`);
    return;
  }
  const names = step === 'all' ? Object.keys(STEPS) : step.split(',');
  for (const n of names) {
    const fn = STEPS[n];
    if (!fn) throw new Error(`unknown step ${n}`);
    console.log(`\n▶ ${n}`);
    await fn();
  }
}

main()
  .catch((e) => { console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

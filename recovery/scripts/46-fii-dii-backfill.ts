/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 4 — NIFTY FII/DII history (IND06 FII flow, IND07 DII absorption,
 * IND14 DII flow).
 *
 * NSE's /api/fiidiiTradeReact is live-only (latest day). History comes from
 * Groww's `v1/api/search/v3/query/fii_dii/st_fii_dii` with
 * `segment=Cash Market&period=custom`, verified 2026-09-14 to be NSE's
 * provisional series: identical to Groww's daily feed for 2026-08-17..28
 * (10/10), and identical on all six figures to NSE live for 2026-09-11.
 * Ranges longer than ~2 weeks come back weekly-aggregated, so the window is
 * fetched in ≤14-calendar-day chunks, each required to contain every NSE
 * trading day.
 *
 * Writes mirror nse-fii-dii.service.ts exactly: same values, same sources
 * (nse_scrape / derived), same metadata keys (IND07's fii_was_net_seller drives
 * the rolling_ratio_excluding handler), same vintage rule (identical → skip;
 * different → retire + insert flagged 'revised'; absent → insert). Provenance
 * is recorded in sourceMetadata.
 *
 * Before writing, the latest NSE live row is fetched and must match the Groww
 * row for that date on all six figures, or nothing is written.
 *
 *   npx tsx recovery/scripts/46-fii-dii-backfill.ts            # fetch + verify, no writes
 *   npx tsx recovery/scripts/46-fii-dii-backfill.ts --apply    # write
 */
import { Prisma, PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { nseClient } from '../../src/core/clients/nse/nse.client';
import type { NseFiiDiiResponse } from '../../src/core/clients/nse/types';

const FROM = '2026-04-27';
const W_END = '2026-09-13';
const GROWW = 'https://groww.in/v1/api/search/v3/query/fii_dii/st_fii_dii';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const APPLY = process.argv.includes('--apply');
const PROVENANCE = {
  provider: 'groww',
  endpoint: 'v1/api/search/v3/query/fii_dii/st_fii_dii (segment=Cash Market, period=custom)',
  historySubstituteFor: 'nse_scrape /api/fiidiiTradeReact (live-only, no history)',
  verifiedAgainstNseLive: '2026-09-11',
  recovery: true,
};

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Side { netBuySell: number; grossBuy: number; grossSell: number }
interface GrowwRow { date: string; fii: Side; dii: Side }

async function growwChunk(start: string, end: string): Promise<GrowwRow[]> {
  const q = new URLSearchParams({ segment: 'Cash Market', period: 'custom', startDate: start, endDate: end });
  const res = await fetch(`${GROWW}?${q}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Groww ${start}..${end}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { data?: GrowwRow[] } };
  return body.data?.data ?? [];
}

async function nseTradingDays(from: string, to: string): Promise<string[]> {
  const holidays = new Set((await prisma.nseHoliday.findMany({ select: { date: true } })).map((h) => iso(h.date)));
  const out: string[] = [];
  for (let d = day(from); d <= day(to); d = new Date(d.getTime() + 864e5)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.has(iso(d))) out.push(iso(d));
  }
  return out;
}

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const six = (fNet: number, fBuy: number, fSell: number, dNet: number, dBuy: number, dSell: number) =>
  [fNet, fBuy, fSell, dNet, dBuy, dSell].map(Number).join('|');

async function main(): Promise<void> {
  console.log(`Stage 4 FII/DII — ${APPLY ? 'APPLY' : 'VERIFY ONLY'} — ${FROM} → ${W_END}`);

  // ── Fetch in ≤14-day chunks ───────────────────────────────────────────────
  const byDate = new Map<string, GrowwRow>();
  const conflicts: string[] = [];
  for (let s = day(FROM); s <= day(W_END); s = new Date(s.getTime() + 14 * 864e5)) {
    const e = new Date(Math.min(s.getTime() + 13 * 864e5, day(W_END).getTime()));
    const rows = await growwChunk(iso(s), iso(e));
    for (const r of rows) {
      if (r.date < iso(s) || r.date > iso(e)) conflicts.push(`${r.date} returned outside chunk ${iso(s)}..${iso(e)}`);
      const prev = byDate.get(r.date);
      const k = six(r.fii.netBuySell, r.fii.grossBuy, r.fii.grossSell, r.dii.netBuySell, r.dii.grossBuy, r.dii.grossSell);
      if (prev && six(prev.fii.netBuySell, prev.fii.grossBuy, prev.fii.grossSell, prev.dii.netBuySell, prev.dii.grossBuy, prev.dii.grossSell) !== k) {
        conflicts.push(`${r.date} differs between chunks`);
      }
      byDate.set(r.date, r);
    }
    console.log(`  chunk ${iso(s)}..${iso(e)}: ${rows.length} rows`);
    await sleep(1000);
  }

  const tradingDays = await nseTradingDays(FROM, W_END);
  const missing = tradingDays.filter((d) => !byDate.has(d));
  const extra = [...byDate.keys()].filter((d) => !tradingDays.includes(d));
  console.log(`\nrows ${byDate.size}; NSE trading days in range ${tradingDays.length}; missing ${missing.length}; extra (not in NSE calendar) ${extra.length}`);
  if (missing.length) console.log(`  missing: ${missing.join(' ')}`);
  if (extra.length) console.log(`  extra: ${extra.join(' ')}`);
  if (conflicts.length) console.log(`  conflicts:\n    ${conflicts.join('\n    ')}`);

  // ── Verify against NSE live ───────────────────────────────────────────────
  const live = await nseClient.get<NseFiiDiiResponse>('/api/fiidiiTradeReact');
  const f = live.find((r) => /FII|FPI/i.test(r.category));
  const d = live.find((r) => /DII/i.test(r.category));
  if (!f || !d) throw new Error('NSE live response missing FII or DII row');
  const [dd, mmm, yyyy] = f.date.split('-');
  const nseDate = `${yyyy}-${MONTHS[mmm]}-${dd}`;
  const nseKey = six(Number(f.netValue), Number(f.buyValue), Number(f.sellValue), Number(d.netValue), Number(d.buyValue), Number(d.sellValue));
  let g = byDate.get(nseDate);
  if (!g && nseDate > W_END) g = (await growwChunk(nseDate, nseDate)).find((r) => r.date === nseDate);
  const gKey = g ? six(g.fii.netBuySell, g.fii.grossBuy, g.fii.grossSell, g.dii.netBuySell, g.dii.grossBuy, g.dii.grossSell) : 'MISSING';
  const verified = gKey === nseKey;
  console.log(`\nNSE live ${nseDate}: ${nseKey}\nGroww    ${nseDate}: ${gKey}\n${verified ? 'SOURCE VERIFIED against NSE live' : 'SOURCE NOT VERIFIED'}`);

  const blockers = [...(verified ? [] : ['source does not match NSE live']), ...(missing.length ? [`${missing.length} NSE trading day(s) missing`] : []), ...conflicts];
  if (blockers.length) {
    console.log(`\nNOT WRITING: ${blockers.join('; ')}`);
    process.exitCode = 2;
    return;
  }
  if (!APPLY) { console.log('\nVerified. Nothing written. Re-run with --apply.'); return; }

  // ── Write, mirroring nse-fii-dii.service.ts persistFiiDii/handle ──────────
  const codes = { fii: 'IND_NIFTY_06_FII_FLOW', dii: 'IND_NIFTY_07_DII_ABSORPTION', diiFlow: 'IND_NIFTY_14_DII_FLOW' };
  const ids: Record<string, string> = {};
  for (const [k, code] of Object.entries(codes)) ids[k] = (await prisma.indicator.findUniqueOrThrow({ where: { code } })).id;
  const log = await prisma.dataFetchLog.create({
    data: {
      jobName: 'recovery_fii_dii_history', triggerType: 'backfill', triggeredBy: 'recovery', status: 'success',
      targetDateFrom: day(FROM), targetDateTo: day(W_END), metadata: PROVENANCE as Prisma.InputJsonObject,
    },
  });

  const tally = { inserted: 0, revised: 0, skipped: 0 };
  for (const date of tradingDays) {
    const r = byDate.get(date)!;
    const observationDate = day(date);
    const fiiNet = r.fii.netBuySell;
    const fiiSell = r.fii.grossSell;
    const diiBuy = r.dii.grossBuy;
    const diiSell = r.dii.grossSell;
    const diiNet = r.dii.netBuySell;
    const fiiWasNetSeller = fiiNet < 0;
    if (fiiWasNetSeller && Math.abs(fiiNet) < 0.01) throw new Error(`${date}: FII net too small to compute absorption`);
    const diiAbsorption = fiiWasNetSeller ? diiNet / Math.abs(fiiNet) : 0;

    await prisma.$transaction(async (tx) => {
      const handle = async (indicatorId: string, value: number, source: 'nse_scrape' | 'derived', sourceMetadata: Prisma.InputJsonValue) => {
        const incoming = new Prisma.Decimal(value);
        const existing = await tx.dataPoint.findFirst({ where: { indicatorId, observationDate, isCurrent: true } });
        if (existing) {
          if (new Prisma.Decimal(existing.value.toString()).equals(incoming)) { tally.skipped++; return; }
          await tx.dataPoint.update({ where: { id: existing.id }, data: { isCurrent: false } });
          await tx.dataPoint.create({ data: { indicatorId, observationDate, value: incoming, isCurrent: true, source, sourceMetadata, fetchedVia: log.id, dataQualityFlag: 'revised' } });
          tally.revised++;
          return;
        }
        await tx.dataPoint.create({ data: { indicatorId, observationDate, value: incoming, isCurrent: true, source, sourceMetadata, fetchedVia: log.id } });
        tally.inserted++;
      };
      await handle(ids.fii, fiiNet, 'nse_scrape', {
        category: 'FII/FPI', buyValue: String(r.fii.grossBuy), sellValue: String(r.fii.grossSell), netValue: String(r.fii.netBuySell), rawDate: date, ...PROVENANCE,
      });
      await handle(ids.dii, diiAbsorption, 'derived', {
        formula: 'dii_net / abs(fii_net)', fii_was_net_seller: fiiWasNetSeller, dii_net_crore: diiNet, dii_buy_crore: diiBuy,
        dii_sell_crore: diiSell, fii_sell_crore: fiiSell, fii_net_crore: fiiNet, derivedFrom: codes.fii, ...PROVENANCE,
      });
      await handle(ids.diiFlow, diiNet, 'nse_scrape', {
        category: 'DII', dii_buy_crore: diiBuy, dii_sell_crore: diiSell, dii_net_crore: diiNet, rawDate: date, ...PROVENANCE,
      });
    });
  }
  await prisma.dataFetchLog.update({ where: { id: log.id }, data: { rowsInserted: tally.inserted, rowsUpdated: tally.revised, rowsSkipped: tally.skipped, completedAt: new Date() } });
  console.log(`\nwritten for ${tradingDays.length} trading days × 3 indicators: ${JSON.stringify(tally)}`);

  // ── Verify written ────────────────────────────────────────────────────────
  let bad = 0;
  for (const date of tradingDays) {
    const r = byDate.get(date)!;
    const rows = await prisma.dataPoint.findMany({ where: { indicatorId: { in: Object.values(ids) }, observationDate: day(date), isCurrent: true } });
    const val = (id: string) => Number(rows.find((x) => x.indicatorId === id)?.value);
    const expectAbs = r.fii.netBuySell < 0 ? r.dii.netBuySell / Math.abs(r.fii.netBuySell) : 0;
    if (val(ids.fii) !== r.fii.netBuySell || val(ids.diiFlow) !== r.dii.netBuySell || Math.abs(val(ids.dii) - expectAbs) > 1e-6) {
      bad++;
      console.log(`  MISMATCH ${date}`);
    }
  }
  console.log(bad === 0 ? `VERIFIED: ${tradingDays.length} days, IND06/07/14 equal the source` : `NOT VERIFIED: ${bad} day(s)`);
  if (bad) process.exitCode = 2;
}

main()
  .catch((e) => { console.error(`\nSTOPPED: ${e instanceof Error ? e.message : e}`); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

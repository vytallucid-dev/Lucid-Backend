/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 2.4 — assert the scoring configuration is in its true final state.
 *
 * Pure SQL against the database, no application code. Checks an explicit
 * manifest and exits non-zero on any FAIL. The central risk this guards: the
 * system comes back healthy-looking while scoring on the wrong rule version.
 * Rules are therefore checked BY DATE — which version is active on a given day —
 * including the v2 → v3 boundary on 2026-08-17 inside the window.
 *
 * STRICTLY READ-ONLY. Exit 0 = pass (WARNs allowed), 2 = at least one FAIL.
 *
 *   npx tsx recovery/scripts/21-assert-config.ts
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL, log: ['warn', 'error'] });
type Row = Record<string, unknown>;
const q = async (sql: string): Promise<Row[]> =>
  (await prisma.$queryRawUnsafe<Array<{ j: Row }>>(`SELECT row_to_json(x) AS j FROM (${sql}) x`)).map((z) => z.j);

const W_START = '2026-05-26';
const W_END = '2026-09-13';

let fails = 0;
let warns = 0;
const pass = (label: string, detail = '') => console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
const fail = (label: string, detail = '') => { fails++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); };
const warn = (label: string, detail = '') => { warns++; console.log(`WARN  ${label}${detail ? `  — ${detail}` : ''}`); };
const check = (ok: boolean, label: string, detail = '') => (ok ? pass(label, detail) : fail(label, detail));
const head = (t: string) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`);

type Def = Record<string, unknown> & { bands?: Array<Record<string, number | null>>; tiers?: Array<Record<string, number | null>> };
async function activeRule(code: string, date: string): Promise<{ version: number; type: string; def: Def } | null> {
  const rows = await q(`
    SELECT r.version, r.rule_definition AS def
    FROM scoring_rules r JOIN indicators i ON i.id = r.indicator_id
    WHERE i.code = '${code}' AND r.effective_from <= '${date}'
      AND (r.effective_to IS NULL OR r.effective_to >= '${date}')
    ORDER BY r.version DESC LIMIT 1`);
  if (!rows.length) return null;
  const def = rows[0].def as Def;
  return { version: Number(rows[0].version), type: String(def?.type), def };
}

async function main(): Promise<void> {
  console.log(`CONFIG ASSERTION — window ${W_START} → ${W_END}`);

  // ── Indicator registry ────────────────────────────────────────────────────
  head('indicator registry');
  const byTool = await q(`SELECT tool::text AS tool, count(*)::int AS n FROM indicators GROUP BY 1 ORDER BY 1`);
  const toolN = (t: string) => Number(byTool.find((r) => r.tool === t)?.n ?? 0);
  check(toolN('nifty') === 14, 'NIFTY indicators = 14', `found ${toolN('nifty')}`);
  check(toolN('edgefinder') === 65, 'EdgeFinder indicators = 65', `found ${toolN('edgefinder')}`);
  if (toolN('shared')) warn('shared-tool indicators present', String(toolN('shared')));

  const efSrc = await q(`SELECT data_source::text AS s, count(*)::int AS n FROM indicators WHERE tool = 'edgefinder' GROUP BY 1`);
  const src = (s: string) => Number(efSrc.find((r) => r.s === s)?.n ?? 0);
  check(src('forex_factory') === 55 && src('cftc') === 9 && src('fred') === 1,
    'EdgeFinder sources: 55 forex_factory, 9 cftc, 1 fred', efSrc.map((r) => `${r.s}=${r.n}`).join(' '));

  const nifty = await q(`SELECT code, data_source::text AS s, source_series_id AS sid FROM indicators WHERE tool = 'nifty' ORDER BY code`);
  const nsrc = new Map(nifty.map((r) => [String(r.code), `${r.s}${r.sid ? `/${r.sid}` : ''}`]));
  const expectSrc: Record<string, string> = {
    IND_NIFTY_03_CPI: 'manual', // D2b — seed says fred
    IND_NIFTY_05_IIP: 'manual', // manual-migrations/002
    IND_NIFTY_10_DXY: 'eodhd/DXY.INDX',
    IND_NIFTY_11_BRENT: 'yahoo/BZ=F',
    IND_NIFTY_12_USDINR: 'eodhd/USDINR.FOREX',
  };
  for (const [code, want] of Object.entries(expectSrc)) {
    const got = nsrc.get(code) ?? '(missing)';
    check(want.includes('/') ? got === want : got.split('/')[0] === want, `${code} source = ${want}`, `found ${got}`);
  }
  console.log(`      all NIFTY: ${nifty.map((r) => `${String(r.code).replace('IND_NIFTY_', '')}=${nsrc.get(String(r.code))}`).join('  ')}`);

  // ── Scoring rules, by date ────────────────────────────────────────────────
  head('NIFTY scoring rules by date');
  for (const r of nifty) {
    const code = String(r.code);
    for (const d of [W_START, W_END]) {
      const a = await activeRule(code, d);
      if (!a) {
        if (code === 'IND_NIFTY_14_DII_FLOW') pass(`${code} has no rule on ${d}`, 'intended — NON_SCORED_NIFTY_INDICATORS in score-writer.service.ts');
        else fail(`${code} has an active rule on ${d}`, 'none found');
        continue;
      }
      if (a.version < 2) fail(`${code} on ${d} is on v${a.version}`, 'v1 must not be active inside the window');
    }
  }

  const expectRule = async (code: string, date: string, version: number, type: string, extra?: (d: Def) => string | null) => {
    const a = await activeRule(code, date);
    if (!a) return fail(`${code} @ ${date}: v${version} ${type}`, 'no active rule');
    const problem = a.version !== version ? `v${a.version}` : a.type !== type ? `type ${a.type}` : extra?.(a.def) ?? null;
    check(problem === null, `${code} @ ${date}: v${version} ${type}`, problem ?? '');
  };
  const sigma = (bands: number) => (d: Def) =>
    d.window_size === 10 && d.sigma_lookback_min === 60 && d.sigma_lookback_max === 250 && (d.bands?.length ?? 0) === bands
      ? null : `window/sigma/bands = ${d.window_size}/${d.sigma_lookback_min}-${d.sigma_lookback_max}/${d.bands?.length}`;

  await expectRule('IND_NIFTY_10_DXY', W_START, 2, 'rolling_pct_direction');
  await expectRule('IND_NIFTY_10_DXY', '2026-08-16', 2, 'rolling_pct_direction');
  await expectRule('IND_NIFTY_10_DXY', '2026-08-17', 3, 'rolling_slope_sigma', sigma(3));
  await expectRule('IND_NIFTY_10_DXY', W_END, 3, 'rolling_slope_sigma', sigma(3));
  await expectRule('IND_NIFTY_11_BRENT', W_START, 2, 'rolling_pct_direction');
  await expectRule('IND_NIFTY_11_BRENT', W_END, 3, 'rolling_slope_sigma', sigma(3));
  await expectRule('IND_NIFTY_12_USDINR', W_START, 2, 'rolling_pct_tiered');
  await expectRule('IND_NIFTY_12_USDINR', W_END, 3, 'rolling_slope_sigma', sigma(5));
  await expectRule('IND_NIFTY_13_FII_LS_RATIO', W_START, 2, 'threshold_bands', (d) => {
    const b = d.bands ?? [];
    const mins = b.map((x) => x.min);
    return mins.includes(50) && mins.includes(28.6) ? null : `bands ${JSON.stringify(b)}`;
  });
  await expectRule('IND_NIFTY_13_FII_LS_RATIO', W_END, 3, 'percentile_rank', (d) =>
    d.window === 'expanding' && d.min_observations === 60 ? null : `window ${d.window}, min_observations ${d.min_observations}`);
  for (const d of [W_START, W_END]) {
    await expectRule('IND_NIFTY_07_DII_ABSORPTION', d, 2, 'rolling_ratio_excluding', (x) =>
      x.formula === 'dii_net / abs(fii_sell)' ? null : `formula "${x.formula}" (the 20260702120100 fix is missing)`);
  }
  await expectRule('IND_NIFTY_03_CPI', W_START, 2, 'two_component_cpi');
  await expectRule('IND_NIFTY_04_RBI_RATE', W_START, 2, 'cycle_regime');

  head('EdgeFinder scoring rules by date');
  const efCodes = (await q(`SELECT code FROM indicators WHERE tool = 'edgefinder' ORDER BY code`)).map((r) => String(r.code));
  for (const d of [W_START, W_END]) {
    const missing: string[] = [];
    for (const c of efCodes) if (!(await activeRule(c, d))) missing.push(c);
    check(missing.length === 0, `all ${efCodes.length} EdgeFinder indicators have an active rule on ${d}`, missing.join(', '));
  }

  head('release ladders (indicator_variants)');
  const LADDERS: Record<string, string[]> = {
    EU_MFG_PMI: ['flash', 'final'], EU_SVC_PMI: ['flash', 'final'],
    UK_MFG_PMI: ['flash', 'final'], UK_SVC_PMI: ['flash', 'final'],
    JP_MFG_PMI: ['flash', 'final'], JP_SVC_PMI: ['flash', 'final'],
    AU_PMI_MFG: ['flash', 'final'], AU_PMI_SVC: ['flash', 'final'],
    US_GDP_QOQ: ['advance', 'second', 'third'],
    EU_GDP_QOQ: ['prelim', 'flash', 'final'], // reads backwards on purpose — see seed-indicator-variants.ts
    JP_GDP_QOQ: ['prelim', 'final'],
    JP_CASH_EARNINGS_YOY: ['prelim', 'final'],
    // Added 2026-09-14 (handoff): the user stores these rungs.
    EU_CPI_YOY: ['flash', 'final'],
    US_CB_CONSCONF: ['prelim', 'final'],
    IND_NIFTY_01_PMI_MFG: ['flash', 'final'],
    IND_NIFTY_02_PMI_SVC: ['flash', 'final'],
  };
  const ladderRows = await q(`
    SELECT i.code, array_agg(v.variant ORDER BY v.ordinal) AS rungs
    FROM indicator_variants v JOIN indicators i ON i.id = v.indicator_id GROUP BY i.code`);
  const ladders = new Map(ladderRows.map((r) => [String(r.code), (r.rungs as string[]).join('→')]));
  for (const [code, rungs] of Object.entries(LADDERS)) {
    const got = ladders.get(code) ?? '(none)';
    check(got === rungs.join('→'), `${code} ladder ${rungs.join('→')}`, `found ${got}`);
  }
  const extra = [...ladders.keys()].filter((c) => !(c in LADDERS));
  check(extra.length === 0, 'no unexpected ladders registered', extra.join(', '));

  head('user measure rules — indicator labels (codes unchanged)');
  const names = new Map((await q(`SELECT code, name FROM indicators`)).map((r) => [String(r.code), String(r.name)]));
  const label = (code: string, ok: (n: string) => boolean, rule: string) =>
    check(ok(names.get(code) ?? ''), `${code} label: ${rule}`, names.get(code) ?? 'missing');
  for (const c of ['US_PPI_MOM', 'EU_PPI_MOM', 'UK_PPI_MOM']) label(c, (n) => /YoY/.test(n) && !/MoM/.test(n), 'PPI is YoY');
  label('JP_RETAIL_YOY', (n) => /MoM/.test(n), 'retail sales is MoM');
  label('JP_TOKYO_CPI_YOY', (n) => !/Core/.test(n), 'Tokyo CPI is headline');
  label('US_CB_CONSCONF', (n) => /Michigan/.test(n), 'Michigan sentiment');
  for (const c of ['EU_MFG_PMI', 'EU_SVC_PMI', 'JP_MFG_PMI', 'JP_SVC_PMI', 'AU_PMI_MFG', 'AU_PMI_SVC']) {
    label(c, (n) => /S&P Global/.test(n), 'S&P Global PMI');
  }
  const [tokyoRow] = await q(`SELECT display_name FROM pair_template_rows WHERE display_name ILIKE '%tokyo%'`);
  check(tokyoRow?.display_name === 'Tokyo CPI', "pair template row 'Tokyo CPI' (must match PAIR_ROW_TO_SLOT)", String(tokyoRow?.display_name));

  head('rating rules');
  for (const tool of ['nifty', 'edgefinder']) {
    for (const d of [W_START, W_END]) {
      const r = await q(`SELECT version FROM scorecard_rating_rules WHERE tool = '${tool}'
                         AND effective_from <= '${d}' AND (effective_to IS NULL OR effective_to >= '${d}')`);
      check(r.length >= 1, `${tool} rating rule active on ${d}`, r.map((x) => `v${x.version}`).join(','));
    }
  }

  // ── Assets and COT ────────────────────────────────────────────────────────
  head('assets and COT metadata');
  const cot: Record<string, string> = { USD: '098662', EUR: '099741', GBP: '096742', JPY: '097741', XAUUSD: '088691' };
  const assets = await q(`SELECT code, metadata->>'cotContractCode' AS cc, metadata->>'cotTraderCategory' AS tc FROM assets ORDER BY code`);
  for (const [code, cc] of Object.entries(cot)) {
    const a = assets.find((x) => x.code === code);
    check(!!a && a.cc === cc && a.tc === 'Non-Commercials', `${code} COT ${cc} / Non-Commercials`, a ? `${a.cc} / ${a.tc}` : 'asset missing');
  }
  console.log(`      assets (${assets.length}): ${assets.map((a) => `${a.code}${a.cc ? `[${a.cc}]` : ''}`).join(' ')}`);

  head('pair templates and asset map');
  const [pt] = await q(`SELECT (SELECT count(*) FROM pair_template_rows)::int AS rows,
                               (SELECT count(*) FROM pair_template_row_currencies)::int AS currencies,
                               (SELECT count(*) FROM asset_indicator_map)::int AS map,
                               (SELECT count(*) FROM indicator_variants)::int AS variants`);
  check(Number(pt.rows) > 0, 'pair_template_rows populated', String(pt.rows));
  check(Number(pt.currencies) > 0, 'pair_template_row_currencies populated', String(pt.currencies));
  check(Number(pt.map) > 0, 'asset_indicator_map populated', String(pt.map));
  check(Number(pt.variants) > 0, 'indicator_variants populated', String(pt.variants));
  const perAsset = await q(`SELECT a.code, count(*)::int AS n FROM asset_indicator_map m JOIN assets a ON a.id = m.asset_id GROUP BY a.code ORDER BY a.code`);
  console.log(`      map rows per asset: ${perAsset.map((r) => `${r.code}=${r.n}`).join(' ')}`);

  // ── Calendars, Compass, stances ───────────────────────────────────────────
  head('NSE holidays');
  const [h] = await q(`SELECT count(*)::int AS n, min(date)::text AS lo, max(date)::text AS hi FROM nse_holidays`);
  check(Number(h.n) === 84 && String(h.lo) <= '2022-01-26' && String(h.hi) >= '2026-12-25', 'nse_holidays: 84 rows, 2022-01-26 → 2026-12-25', `${h.n} rows, ${h.lo} → ${h.hi}`);
  const inW = await q(`SELECT date::text AS d, name FROM nse_holidays WHERE date BETWEEN '${W_START}' AND '${W_END}' ORDER BY date`);
  console.log(`      holidays in window: ${inW.map((r) => `${r.d} ${r.name}`).join('; ') || '(none)'}`);

  head('Compass config');
  for (const d of [W_START, W_END]) {
    const c = await q(`SELECT version_label FROM compass_config WHERE effective_from <= '${d}' AND (effective_to IS NULL OR effective_to >= '${d}')`);
    check(c.length === 1, `exactly one compass_config effective on ${d}`, c.map((x) => x.version_label).join(',') || 'none');
  }

  head('currency cycle stances (judgment inputs)');
  for (const ccy of ['USD', 'EUR', 'GBP', 'JPY', 'AUD']) {
    const s = await q(`SELECT stance, effective_from::text AS f, fed_constraint AS fc, notes FROM currency_cycle_stance
                       WHERE currency_code = '${ccy}' AND effective_from <= '${W_START}' ORDER BY effective_from DESC LIMIT 1`);
    if (!s.length) { fail(`${ccy} has a stance effective by ${W_START}`); continue; }
    const r = s[0];
    const line = `${r.stance} from ${r.f}${r.fc ? `, fed_constraint ${r.fc}` : ''}`;
    if (/PLACEHOLDER/i.test(String(r.notes ?? ''))) warn(`${ccy} stance is a PLACEHOLDER`, `${line} — needs the user's real value`);
    else pass(`${ccy} stance`, line);
  }
  warn('stances are the seed values effective 2026-01-01', 'any change during 2026 must be supplied by the user (MANUAL_DATA_COLLECTION §5)');

  console.log(`\n${fails === 0 ? 'CONFIG VERIFIED' : 'CONFIG NOT VERIFIED'} — ${fails} fail, ${warns} warn\n`);
  if (fails) process.exitCode = 2;
}

main()
  .catch((e) => { console.error('\nASSERT FAILED TO RUN:', e instanceof Error ? e.message : e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

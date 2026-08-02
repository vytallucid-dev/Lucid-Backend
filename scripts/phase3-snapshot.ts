/* eslint-disable no-console */
/**
 * Phase 3 Oracle API snapshot tool (dev/verification only — not app code).
 *
 * Mounts the real oracleRouter against the real database and captures every
 * endpoint's full response to JSON, outside the source tree, so the Phase 3
 * API cutover can be diffed for regressions.
 *
 * Auth is applied at the app mount point (app.ts), not inside the router, so
 * mounting the router bare exercises the exact handler code without a token.
 *
 * Usage: tsx scripts/phase3-snapshot.ts <label> <outDir>
 */
import { writeFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { oracleRouter } from '@modules/edgefinder/api/oracle.routes';
import { errorHandler } from '@core/middleware/error-handler';

const ASSET_KEYS = ['USD', 'EUR', 'GBP', 'JPY', 'Gold', 'AUD', 'SPY', 'NAS100', 'US30', 'NOPE'];
const PAIR_KEYS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'GBPJPY',
  'AUDUSD', 'AUDJPY', 'EURAUD', 'GBPAUD', 'NOPE',
];
const COT_HISTORY_KEYS = ['USD', 'EUR', 'GBP', 'JPY', 'Gold', 'AUD', 'SPY'];

async function main(): Promise<void> {
  const [label, outDir] = process.argv.slice(2);
  if (!label || !outDir) throw new Error('Usage: phase3-snapshot.ts <label> <outDir>');

  const app = express();
  app.use(express.json());
  app.use('/api/oracle', oracleRouter);
  app.use(errorHandler);

  const out: Record<string, { status: number; body: unknown }> = {};

  const call = async (path: string): Promise<void> => {
    const r = await request(app).get(path);
    out[path] = { status: r.status, body: r.body };
    const n = Array.isArray(r.body?.data) ? ` (${r.body.data.length} items)` : '';
    console.log(`  ${String(r.status).padEnd(4)} ${path}${n}`);
  };

  console.log(`=== SNAPSHOT "${label}" ===`);
  await call('/api/oracle/compass');
  await call('/api/oracle/assets');
  await call('/api/oracle/cot');
  await call('/api/oracle/heatmap');
  await call('/api/oracle/cycle-stances');
  await call('/api/oracle/fx-scorecard');
  for (const k of ASSET_KEYS) await call(`/api/oracle/scorecard?asset=${k}`);
  for (const p of PAIR_KEYS) await call(`/api/oracle/fx-scorecard?pair=${p}`);
  for (const s of [...ASSET_KEYS, ...PAIR_KEYS]) {
    await call(`/api/oracle/score-history?subject=${s}&range=3M`);
  }
  for (const a of COT_HISTORY_KEYS) await call(`/api/oracle/cot-history?asset=${a}&range=6M`);
  for (const c of ['US_CPI_YOY', 'AU_CPI_YOY', 'JP_TOKYO_CPI_YOY', 'AU_PPI_YOY']) {
    await call(`/api/oracle/indicator-history?code=${c}&range=3M`);
  }

  const outPath = `${outDir}/phase3-${label}.json`;
  writeFileSync(outPath, JSON.stringify({ label, responses: out }, null, 2), 'utf8');
  console.log(`\nWROTE: ${outPath}  (${Object.keys(out).length} responses)`);
}

main().catch((e) => {
  console.error('SNAPSHOT FAILED', e);
  process.exitCode = 1;
});

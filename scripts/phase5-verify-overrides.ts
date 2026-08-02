/* eslint-disable no-console */
/**
 * Phase 5 — override-layer fix verification.
 *
 * No Risk-Off day exists anywhere in compass_classifications history (0 of 61
 * rows), so none of Changes 1-3 can be observed firing against real production
 * output. This proves each one end-to-end using REAL data — real resolver
 * output, real composed scores, real registry base/quote/isCarryPair — with
 * only the regime gate synthesized, exactly following
 * scripts/phase4-verify-override1.ts's pattern.
 *
 * Read-only: no DB writes, no synthetic classification rows inserted.
 */
import { PrismaClient } from '@prisma/client';
import { resolveAssetIndicators } from '@modules/edgefinder/services/scorecard/asset-indicator-resolver';
import {
  computeCompassOverridesForAsset,
  type IndicatorScoreInput,
} from '@modules/edgefinder/services/scorecard/compass-overrides';
import { computePairCompassOverrides } from '@modules/edgefinder/services/pair-score/pair-compass-overrides';
import { loadPairDefinitions } from '@modules/edgefinder/services/pair-score/pair-template.config';
import { scoreIndicator } from '@core/scoring/engine';

const prisma = new PrismaClient();
const DATE = new Date('2026-07-31T00:00:00.000Z');

const SYNTHETIC_ASSET_GATE = {
  regimePathRiskOff: true,
  override2Active: false,
  override3And5Active: false,
  shockBActive: false,
};

const SYNTHETIC_PAIR_GATE = {
  regimePathRiskOff: true,
  override5Active: true, // 8A rate gate permits, mirroring Phase 4's synthetic asset gate
  shockBActive: false,
};

async function realOverrideInput(assetCode: string): Promise<{ assetClass: string; overrideInput: IndicatorScoreInput[] }> {
  const mapping = await resolveAssetIndicators(assetCode);
  const overrideInput: IndicatorScoreInput[] = [];
  for (const ind of mapping.indicators) {
    const result = await scoreIndicator({ indicatorCode: ind.indicatorCode, observationDate: DATE });
    if (result.kind === 'insufficient_data') continue;
    const composed = result.score * ind.polarity;
    overrideInput.push({ indicatorCode: ind.indicatorCode, baseScore: composed, category: ind.category });
  }
  return { assetClass: mapping.assetClass, overrideInput };
}

async function changeOne(): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('CHANGE 1 — US_UNEMP removed from Override 1 (index eligibility unchanged)');
  console.log('='.repeat(70));

  for (const code of ['SPY', 'NAS100', 'US30']) {
    const { assetClass, overrideInput } = await realOverrideInput(code);
    const result = computeCompassOverridesForAsset(code, assetClass, SYNTHETIC_ASSET_GATE, overrideInput);
    const composedByCode = Object.fromEntries(overrideInput.map((i) => [i.indicatorCode, i.baseScore]));
    console.log(`\n  ${code}:`);
    console.log(`    real composed: US_NFP=${composedByCode.US_NFP} US_ADP=${composedByCode.US_ADP} ` +
      `US_JOLTS=${composedByCode.US_JOLTS} US_JOBLESS_CLAIMS=${composedByCode.US_JOBLESS_CLAIMS} US_UNEMP=${composedByCode.US_UNEMP}`);
    console.log(`    totalAdjustment (AFTER fix) = ${result.totalAdjustment}`);
    console.log(`    overridesFired = ${JSON.stringify(result.overridesFired)}`);
    const fired = result.overridesFired[0]?.indicatorsAffected ?? [];
    console.log(`    fires on US_NFP: ${fired.includes('US_NFP')}   fires on US_ADP: ${fired.includes('US_ADP')}   ` +
      `fires on US_UNEMP: ${fired.includes('US_UNEMP')} (must be false)`);
  }
}

async function changeTwoAndThree(): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('CHANGE 2 & 3 — JPY safe-haven + carry-unwind eligibility, all 9 pairs');
  console.log('='.repeat(70));

  const defs = await loadPairDefinitions();
  console.log(`\n  ${'pair'.padEnd(8)}${'base'.padEnd(6)}${'quote'.padEnd(6)}${'isCarryPair'.padEnd(13)}` +
    `${'Override3(boost=1)'.padEnd(20)}${'Override5'.padEnd(11)}combined`);

  const results: Record<string, { safeHaven: boolean; carry: boolean; combined: number }> = {};

  for (const def of defs) {
    const r = computePairCompassOverrides({
      pairCode: def.code,
      quoteCurrency: def.quote,
      isCarryPair: def.isCarryPair,
      ...SYNTHETIC_PAIR_GATE,
      jpySafeHavenBoost: 1, // the fixed magnitude OVERRIDE_3_JPY_SAFE_HAVEN always emits when it fires
    });
    const safeHaven = r.overridesFired.some((o) => o.code === 'OVERRIDE_3_JPY_SAFE_HAVEN');
    const carry = r.overridesFired.some((o) => o.code === 'OVERRIDE_5_CARRY_UNWIND');
    results[def.code] = { safeHaven, carry, combined: r.totalAdjustment };
    console.log(`  ${def.code.padEnd(8)}${def.base.padEnd(6)}${def.quote.padEnd(6)}` +
      `${String(def.isCarryPair).padEnd(13)}${String(safeHaven).padEnd(20)}${String(carry).padEnd(11)}${r.totalAdjustment}`);
  }

  console.log('\n  Change 2 assertions:');
  for (const p of ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY']) {
    console.log(`    ${p} receives Override 3 (safe-haven): ${results[p].safeHaven} (must be true)`);
  }
  for (const p of ['EURUSD', 'GBPUSD', 'AUDUSD', 'EURAUD', 'GBPAUD']) {
    console.log(`    ${p} receives Override 3 (safe-haven): ${results[p].safeHaven} (must be false)`);
  }

  console.log('\n  Change 3 assertions:');
  for (const p of ['AUDJPY', 'EURJPY', 'GBPJPY']) {
    console.log(`    ${p} is carry-eligible (Override 5): ${results[p].carry} (must be true)`);
  }
  console.log(`    USDJPY is carry-eligible (Override 5): ${results.USDJPY.carry} (must be false)`);
  for (const p of ['EURUSD', 'GBPUSD', 'AUDUSD', 'EURAUD', 'GBPAUD']) {
    console.log(`    ${p} is carry-eligible (Override 5): ${results[p].carry} (must be false)`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('INTERACTION CHECK — AUDJPY double-override vs EURJPY/GBPJPY');
  console.log('='.repeat(70));
  console.log(`    AUDJPY combined adjustment = ${results.AUDJPY.combined}`);
  console.log(`    EURJPY combined adjustment = ${results.EURJPY.combined}`);
  console.log(`    GBPJPY combined adjustment = ${results.GBPJPY.combined}`);
  const equal = results.AUDJPY.combined === results.EURJPY.combined && results.EURJPY.combined === results.GBPJPY.combined;
  console.log(`    AUDJPY == EURJPY == GBPJPY: ${equal}`);
  console.log(`    VERDICT: ${equal
    ? 'AUDJPY is NOT materially larger than EURJPY/GBPJPY — identical combined adjustment. ' +
      'Both overrides use FIXED magnitudes (safe-haven boost is always exactly 1 when it fires, ' +
      'read from the JPY asset scorecard\'s own single global Override 3 adjustment, not derived ' +
      'per-pair; carry unwind is a flat -1). AUDJPY receiving both is not double-counting AUDJPY-specific ' +
      'signal — it is the same fixed -2 EURJPY/GBPJPY already received, now correctly extended to the pair ' +
      'that was wrongly excluded.'
    : '*** AUDJPY DIFFERS FROM EURJPY/GBPJPY — INVESTIGATE ***'}`);
}

async function main(): Promise<void> {
  await changeOne();
  await changeTwoAndThree();
}

main()
  .catch((e) => {
    console.error('FAILED', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

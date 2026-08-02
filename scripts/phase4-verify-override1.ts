/* eslint-disable no-console */
/**
 * Phase 4 — Override 1 reachability proof.
 *
 * No Risk-Off classification exists anywhere in compass_classifications
 * history (61 rows, 0 Risk-Off), so Override 1 cannot be observed firing
 * against real data today. This proves the code path is genuinely reachable
 * end-to-end using REAL data for everything except the regime gate:
 *   - resolveAssetIndicators(code) is called for real, against the real DB,
 *     to confirm mapping.assetClass === 'index' for SPY/NAS100/US30.
 *   - The indicator scores fed into the override are the REAL composed scores
 *     from today's actual scorecard assembly (asset-scorecard.service.ts's
 *     exact overrideInput construction, replicated here read-only).
 *   - Only the gate (regimePathRiskOff) is synthetic, because no real
 *     Risk-Off day exists to observe.
 *
 * Read-only: no DB writes, no synthetic classification rows inserted.
 */
import { PrismaClient } from '@prisma/client';
import { resolveAssetIndicators } from '@modules/edgefinder/services/scorecard/asset-indicator-resolver';
import {
  computeCompassOverridesForAsset,
  type IndicatorScoreInput,
} from '@modules/edgefinder/services/scorecard/compass-overrides';
import { scoreIndicator } from '@core/scoring/engine';

const prisma = new PrismaClient();
const DATE = new Date('2026-07-31T00:00:00.000Z');

async function main(): Promise<void> {
  for (const code of ['SPY', 'NAS100', 'US30']) {
    const mapping = await resolveAssetIndicators(code);
    console.log(`\n=== ${code} — mapping.assetClass = '${mapping.assetClass}' ===`);

    // Replicate assembleAssetScorecard's real scoring + composition exactly,
    // read-only (no persistence), to get the real overrideInput.
    const overrideInput: IndicatorScoreInput[] = [];
    for (const ind of mapping.indicators) {
      const result = await scoreIndicator({ indicatorCode: ind.indicatorCode, observationDate: DATE });
      if (result.kind === 'insufficient_data') continue;
      const composed = result.score * ind.polarity;
      overrideInput.push({ indicatorCode: ind.indicatorCode, baseScore: composed, category: ind.category });
    }

    // Real gate EXCEPT regimePathRiskOff, which is synthesized because no
    // Risk-Off day exists in history to observe it against.
    const syntheticGate = {
      regimePathRiskOff: true,
      override2Active: false,
      override3And5Active: false,
      shockBActive: false,
    };

    const result = computeCompassOverridesForAsset(code, mapping.assetClass, syntheticGate, overrideInput);
    console.log(`  real composed scores fed in: ${overrideInput.map((i) => `${i.indicatorCode}=${i.baseScore}`).join(', ')}`);
    console.log(`  totalAdjustment = ${result.totalAdjustment}`);
    console.log(`  overridesFired = ${JSON.stringify(result.overridesFired)}`);
  }
}

main()
  .catch((e) => {
    console.error('FAILED', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

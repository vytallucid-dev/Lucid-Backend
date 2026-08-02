/* eslint-disable no-console */
/**
 * Phase 2 targeted verification (dev only — not app code).
 *  1. AU_EMPL sign inversion: AUD as base vs AUD as quote, with a synthetic
 *     non-zero score, because the real indicator has no data yet.
 *  2. Gold polarity reproduces the old boolean flip exactly.
 *  3. An asset with no map rows throws a clear, named error.
 */
import { PrismaClient } from '@prisma/client';
import { evaluatePairRow } from '@modules/edgefinder/services/pair-score/pair-row-calculator';
import {
  loadPairTemplateFromDb,
  loadPairDefinitions,
} from '@modules/edgefinder/services/pair-score/pair-template.config';
import { resolveAssetIndicators } from '@modules/edgefinder/services/scorecard/asset-indicator-resolver';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const template = await loadPairTemplateFromDb();
  const defs = await loadPairDefinitions();
  const auEmpl = template.find((r) => r.rowName === 'AU Employment Change');
  if (!auEmpl) throw new Error('AU Employment Change row not found in template');

  console.log('=== 1. AU_EMPL SIGN INVERSION (synthetic score +1 for AU_EMPLOYMENT_CHANGE) ===');
  console.log(`   row config: indicators=${JSON.stringify(auEmpl.indicators)} requiresCurrency=${JSON.stringify(auEmpl.requiresCurrency)} softExclude=${auEmpl.softExcludeWhenUnsupported}`);
  const synthetic = {
    indicatorCode: 'AU_EMPLOYMENT_CHANGE',
    score: 1,
    direction: 'BEAT',
    outcome: 'scored' as const,
  };
  for (const code of ['AUDJPY', 'EURAUD']) {
    const def = defs.find((d) => d.code === code);
    if (!def) throw new Error(`${code} not in registry`);
    const isBase = def.base === 'AUD';
    const r = evaluatePairRow({
      config: auEmpl,
      baseCurrency: def.base,
      quoteCurrency: def.quote,
      baseScore: isBase ? synthetic : null,
      quoteScore: isBase ? null : synthetic,
    });
    console.log(
      `   ${code} (base=${def.base} quote=${def.quote}): AUD is ${isBase ? 'BASE ' : 'QUOTE'} → pairScore=${r.pairScore >= 0 ? '+' : ''}${r.pairScore}  included=${r.rowIncluded}`,
    );
  }

  console.log('\n=== 2. GOLD POLARITY vs OLD BOOLEAN FLIP ===');
  const gold = await resolveAssetIndicators('XAUUSD');
  const usd = await resolveAssetIndicators('USD');
  let mismatches = 0;
  for (const i of gold.indicators) {
    const oldFlip = !i.isCot; // old rule: flip every non-COT indicator for Gold
    const newFlip = i.polarity === -1;
    if (oldFlip !== newFlip) {
      mismatches++;
      console.log(`   MISMATCH ${i.indicatorCode}: oldFlip=${oldFlip} polarity=${i.polarity}`);
    }
  }
  console.log(
    `   XAUUSD: ${gold.indicators.length} mapped, ${gold.indicators.filter((i) => i.polarity === -1).length} at polarity -1, ` +
      `${gold.indicators.filter((i) => i.isCot).length} COT at +1 → ${mismatches} divergence(s) from the old boolean`,
  );
  console.log(
    `   USD:    ${usd.indicators.length} mapped, all polarity +1 = ${usd.indicators.every((i) => i.polarity === 1)}`,
  );
  const goldCodes = gold.indicators.filter((i) => !i.isCot).map((i) => i.indicatorCode).sort();
  const usdCodes = usd.indicators.filter((i) => !i.isCot).map((i) => i.indicatorCode).sort();
  console.log(
    `   Gold non-COT set === USD non-COT set: ${JSON.stringify(goldCodes) === JSON.stringify(usdCodes)}`,
  );

  console.log('\n=== 3. UNMAPPED ASSET THROWS ===');
  // DXY is a real, active, EdgeFinder-scoped asset with zero map rows.
  try {
    await resolveAssetIndicators('DXY');
    console.log('   *** DID NOT THROW — this is a failure ***');
  } catch (err) {
    console.log(`   DXY  -> ${(err as Error).message}`);
  }
  try {
    await resolveAssetIndicators('NZDUSD');
    console.log('   *** DID NOT THROW — this is a failure ***');
  } catch (err) {
    console.log(`   NZDUSD (nonexistent) -> ${(err as Error).message}`);
  }

  console.log('\n=== 4. REGISTRY-DERIVED UNIVERSES ===');
  console.log(`   pairs:  ${defs.map((d) => `${d.code}(${d.base}/${d.quote})`).join(', ')}`);
  const assets = await prisma.asset.findMany({
    where: { isActive: true, toolScope: { has: 'edgefinder' }, indicatorMaps: { some: {} } },
    select: { code: true },
    orderBy: { code: 'asc' },
  });
  console.log(`   assets: ${assets.map((a) => a.code).join(', ')}`);
  console.log(`   template rows active: ${template.length}`);
}

main()
  .catch((e) => {
    console.error('VERIFY FAILED', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

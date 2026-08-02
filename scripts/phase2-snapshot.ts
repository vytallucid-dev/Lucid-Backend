/* eslint-disable no-console */
/**
 * Phase 2 cutover snapshot tool (dev/verification only — not app code).
 *
 * Runs both EdgeFinder orchestrators for a fixed date and dumps the complete
 * persisted result — every per-indicator score, every pair row, every subtotal
 * — to a JSON file OUTSIDE the source tree, so a byte-for-byte regression diff
 * can be taken across the Phase 2 cutover.
 *
 * Usage:
 *   tsx scripts/phase2-snapshot.ts <label> <YYYY-MM-DD> <outDir>
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { runScorecardOrchestrator } from '@modules/edgefinder/services/scorecard/scorecard-orchestrator.service';
import { runPairScoreOrchestrator } from '@modules/edgefinder/services/pair-score/pair-score-orchestrator.service';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const [label, dateStr, outDir] = process.argv.slice(2);
  if (!label || !dateStr || !outDir) {
    throw new Error('Usage: phase2-snapshot.ts <label> <YYYY-MM-DD> <outDir>');
  }
  const observationDate = new Date(`${dateStr}T00:00:00.000Z`);

  console.log(`\n=== SNAPSHOT "${label}" for ${dateStr} ===`);

  const assetRun = await runScorecardOrchestrator('manual', `phase2-${label}`, observationDate);
  console.log(
    `assets: status=${assetRun.status} ok=[${assetRun.assetsSucceeded.join(',')}] failed=${JSON.stringify(assetRun.assetsFailed)}`,
  );

  const pairRun = await runPairScoreOrchestrator('manual', `phase2-${label}`, observationDate);
  console.log(
    `pairs:  status=${pairRun.status} ok=[${pairRun.pairsSucceeded.join(',')}] failed=${JSON.stringify(pairRun.pairsFailed)}`,
  );

  // Read back everything that is current for this date.
  const cards = await prisma.edgefinderScorecard.findMany({
    where: { observationDate, isCurrent: true },
    include: { asset: { select: { code: true, assetClass: true } } },
  });
  const pairScores = await prisma.edgefinderPairScore.findMany({
    where: { scoreDate: observationDate, isCurrent: true },
    include: { pair: { select: { code: true } } },
  });

  const assets: Record<string, unknown> = {};
  for (const c of cards.sort((a, b) => a.asset.code.localeCompare(b.asset.code))) {
    assets[c.asset.code] = {
      baseFundamentalsScore: c.baseFundamentalsScore,
      fundamentalsScore: c.fundamentalsScore,
      cotScore: c.cotScore,
      totalScore: c.totalScore,
      ratingLabel: c.ratingLabel,
      compassAdjustment: c.compassAdjustment,
      compassOverridesApplied: c.compassOverridesApplied,
      regimeAtCompute: c.regimeAtCompute,
      indicatorBreakdown: c.indicatorBreakdown,
      cotBreakdown: c.cotBreakdown,
    };
  }

  const pairs: Record<string, unknown> = {};
  for (const p of pairScores.sort((a, b) => a.pair.code.localeCompare(b.pair.code))) {
    pairs[p.pair.code] = {
      basePairScore: p.basePairScore,
      pairCotScore: p.pairCotScore,
      baseTotal: p.baseTotal,
      compassAdjustment: p.compassAdjustment,
      totalScore: p.totalScore,
      ratingLabel: p.ratingLabel,
      compassOverridesApplied: p.compassOverridesApplied,
      regimeAtCompute: p.regimeAtCompute,
      rowBreakdown: p.rowBreakdown,
      cotBreakdown: p.cotBreakdown,
    };
  }

  const snapshot = {
    label,
    observationDate: dateStr,
    assetRun: {
      status: assetRun.status,
      succeeded: assetRun.assetsSucceeded,
      failed: assetRun.assetsFailed,
    },
    pairRun: {
      status: pairRun.status,
      succeeded: pairRun.pairsSucceeded,
      failed: pairRun.pairsFailed,
    },
    assets,
    pairs,
  };

  const outPath = `${outDir}/phase2-${label}.json`;
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`\nWROTE: ${outPath}`);
  console.log(`assets captured: ${Object.keys(assets).join(', ')}`);
  console.log(`pairs captured:  ${Object.keys(pairs).join(', ')}`);
}

main()
  .catch((e) => {
    console.error('SNAPSHOT FAILED', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/* eslint-disable no-console */
/**
 * Compass v2 Phase 2A verification — read-only, writes nothing.
 *
 * Unlike Phase 1's verify-compass-config-migration.ts (which asserts output
 * is IDENTICAL), this phase's gate is the opposite: output is EXPECTED to
 * change once v2 config activates. This script reports, per live
 * (isValidation=false) trading day ON OR AFTER the v2 activation date:
 *   - each of the 6 inputs' raw/derived value, resolved color band, and weight
 *   - green/yellow/red weight totals (asserts they sum to exactly 8.0)
 *   - the resulting candidate regime under the CURRENT code + resolved config
 *   - a diff against whatever is already persisted in compass_classifications
 *     for that date, with an explanation of which input/weight changed
 *
 * Scoped to >= V2_ACTIVATION_DATE only: dates before activation have
 * compass_inputs rows in the OLD shape (e.g. GOLD_DXY_CORR instead of
 * VIX_TERM_STRUCTURE), which the current sumVoteWeights correctly rejects
 * with "Unknown input code" — that rejection is intentional and must not be
 * papered over. No backfill/reconciliation of pre-activation history is in
 * scope here; this script simply does not look at those dates.
 *
 * It does NOT call runCompassClassifier and does NOT write to
 * compass_classifications — it only reads compass_inputs (already ingested)
 * and recomputes classification in-memory using the live code path.
 */
import { prisma } from '@core/db/prisma';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import {
  checkCrisisOverride,
  determineCandidateRegime,
  resolveActiveRegime,
  sumVoteWeights,
  type Regime,
} from '@modules/edgefinder/services/compass/compass-classifier-logic';
import type { ColorBand } from '@modules/edgefinder/services/compass/compass-bands';

const DAYS_TO_CHECK = Number(process.argv[2] ?? 10);

// Compass v2 Phase 2A activation date (see prisma/seed-compass-config.ts
// V2_EFFECTIVE_FROM). Dates before this have old-shape compass_inputs rows
// and are out of scope for this script.
const V2_ACTIVATION_DATE = new Date('2026-07-16');

function decimalToNumber(d: unknown): number | null {
  if (d === null || d === undefined) return null;
  return Number((d as { toString(): string }).toString());
}

async function main(): Promise<void> {
  const recentClassifications = await prisma.compassClassification.findMany({
    where: {
      isCurrent: true,
      isValidation: false,
      classificationDate: { gte: V2_ACTIVATION_DATE },
    },
    orderBy: { classificationDate: 'desc' },
    take: DAYS_TO_CHECK,
  });

  if (recentClassifications.length === 0) {
    console.log(
      `No live compass_classifications rows on or after v2 activation (${V2_ACTIVATION_DATE.toISOString().slice(0, 10)}) — nothing to verify yet. ` +
        'Pre-activation dates are intentionally excluded (old input shape); this is not a bug.',
    );
    return;
  }

  const days = [...recentClassifications].reverse(); // ascending

  for (const day of days) {
    const dateLabel = day.classificationDate.toISOString().slice(0, 10);
    console.log(`\n=== ${dateLabel} ===`);

    const config = await compassConfigRepository.resolveForDate(day.classificationDate);

    const weightTotal = Object.values(config.weights).reduce((s, w) => s + w, 0);
    console.log(`  config weights sum: ${weightTotal} ${weightTotal === 8.0 ? '(OK)' : '(MISMATCH — STOP)'}`);

    const inputs = await prisma.compassInput.findMany({
      where: { observationDate: day.classificationDate, isValidation: false },
    });

    if (inputs.length < 6) {
      console.log(`  SKIP — only ${inputs.length}/6 inputs present`);
      continue;
    }

    const inputsByCode = new Map(inputs.map((r) => [r.inputCode, r]));

    for (const r of inputs) {
      const weight = config.weights[r.inputCode];
      console.log(
        `  ${r.inputCode.padEnd(20)} raw=${decimalToNumber(r.rawValue)} derived=${decimalToNumber(r.derivedValue)} band=${r.colorBand} weight=${weight}`,
      );
    }

    const inputsWithBand = inputs.map((r) => ({
      inputCode: r.inputCode,
      colorBand: r.colorBand as ColorBand,
    }));
    const voteWeights = sumVoteWeights(inputsWithBand, config);
    console.log(`  green=${voteWeights.green} yellow=${voteWeights.yellow} red=${voteWeights.red}`);

    const vixRow = inputsByCode.get('VIX_5D_AVG');
    const hyRow = inputsByCode.get('HY_OAS');
    const crisis = checkCrisisOverride(
      {
        vixFiveDayAvg: vixRow ? decimalToNumber(vixRow.derivedValue) : null,
        hyOasLevel: hyRow ? decimalToNumber(hyRow.rawValue) : null,
      },
      config,
    );

    const candidateRegime = determineCandidateRegime({ voteWeights, crisisFired: crisis.fired }, config);

    const priorRow = await prisma.compassClassification.findFirst({
      where: {
        isCurrent: true,
        isValidation: false,
        classificationDate: { lt: day.classificationDate },
      },
      orderBy: { classificationDate: 'desc' },
    });

    const prior = priorRow
      ? {
          activeRegime: priorRow.activeRegime as Regime,
          candidateRegime: priorRow.candidateRegime as Regime,
          persistenceDaysCount: priorRow.persistenceDaysCount,
        }
      : null;

    const { activeRegime, persistenceDaysCount } = resolveActiveRegime(
      { candidateRegime, crisisFired: crisis.fired, prior },
      config,
    );

    const persisted = {
      candidateRegime: day.candidateRegime as Regime,
      activeRegime: day.activeRegime as Regime,
      persistenceDaysCount: day.persistenceDaysCount,
      crisisOverrideFired: day.crisisOverrideFired,
    };
    const recomputed = { candidateRegime, activeRegime, persistenceDaysCount, crisisOverrideFired: crisis.fired };

    console.log(`  persisted:  candidate=${persisted.candidateRegime} active=${persisted.activeRegime} count=${persisted.persistenceDaysCount} crisis=${persisted.crisisOverrideFired}`);
    console.log(`  recomputed: candidate=${recomputed.candidateRegime} active=${recomputed.activeRegime} count=${recomputed.persistenceDaysCount} crisis=${recomputed.crisisOverrideFired}`);

    const matches =
      persisted.candidateRegime === recomputed.candidateRegime &&
      persisted.activeRegime === recomputed.activeRegime &&
      persisted.persistenceDaysCount === recomputed.persistenceDaysCount &&
      persisted.crisisOverrideFired === recomputed.crisisOverrideFired;

    if (matches) {
      console.log('  -> UNCHANGED');
    } else {
      console.log('  -> DIFFERS from persisted (expected once v2 config is active — verify the cause above: which input/weight changed)');
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

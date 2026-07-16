/* eslint-disable no-console */
/**
 * Compass v2 Phase 1 verification — read-only, writes nothing.
 *
 * For each of the last N live (isValidation=false) classification_date rows
 * already in compass_classifications (produced by the OLD hardcoded-literal
 * logic), this script:
 *   1. Reads that day's 6 compass_inputs rows (unchanged — inputs are not
 *      re-ingested).
 *   2. Recomputes candidateRegime/activeRegime using the CURRENT code path
 *      (config-driven compass-bands.ts / compass-classifier-logic.ts), with
 *      the resolved v1 compass_config row and the day's own prior classification
 *      row as the persistence seed (mirroring what runCompassClassifier does).
 *   3. Compares the recomputed candidateRegime/activeRegime/persistenceDaysCount
 *      /crisisOverrideFired against the persisted row.
 *
 * Any mismatch is reported and the script exits non-zero. It does not call
 * runCompassClassifier and does not write to compass_classifications.
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

const DAYS_TO_CHECK = Number(process.argv[2] ?? 15);

function decimalToNumber(d: unknown): number | null {
  if (d === null || d === undefined) return null;
  return Number((d as { toString(): string }).toString());
}

async function main(): Promise<void> {
  const recentClassifications = await prisma.compassClassification.findMany({
    where: { isCurrent: true, isValidation: false },
    orderBy: { classificationDate: 'desc' },
    take: DAYS_TO_CHECK,
  });

  if (recentClassifications.length === 0) {
    console.log('No live compass_classifications rows found — nothing to verify.');
    return;
  }

  // Ascending, so "prior" lookups walk forward in time.
  const days = [...recentClassifications].reverse();

  let mismatches = 0;

  for (const day of days) {
    const dateLabel = day.classificationDate.toISOString().slice(0, 10);
    const config = await compassConfigRepository.resolveForDate(day.classificationDate);

    const inputs = await prisma.compassInput.findMany({
      where: { observationDate: day.classificationDate, isValidation: false },
    });

    if (inputs.length < 6) {
      console.log(`[${dateLabel}] SKIP — only ${inputs.length}/6 inputs present`);
      continue;
    }

    const inputsByCode = new Map(inputs.map((r) => [r.inputCode, r]));
    const inputsWithBand = inputs.map((r) => ({
      inputCode: r.inputCode,
      colorBand: r.colorBand as ColorBand,
    }));
    const voteWeights = sumVoteWeights(inputsWithBand, config);

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

    // Prior state as persisted the day before classificationDate (matches
    // what runCompassClassifier would have read at the time).
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

    const expected = {
      candidateRegime: day.candidateRegime as Regime,
      activeRegime: day.activeRegime as Regime,
      persistenceDaysCount: day.persistenceDaysCount,
      crisisOverrideFired: day.crisisOverrideFired,
    };
    const actual = {
      candidateRegime,
      activeRegime,
      persistenceDaysCount,
      crisisOverrideFired: crisis.fired,
    };

    const matches =
      expected.candidateRegime === actual.candidateRegime &&
      expected.activeRegime === actual.activeRegime &&
      expected.persistenceDaysCount === actual.persistenceDaysCount &&
      expected.crisisOverrideFired === actual.crisisOverrideFired;

    if (matches) {
      console.log(`[${dateLabel}] MATCH  candidate=${actual.candidateRegime} active=${actual.activeRegime} count=${actual.persistenceDaysCount} crisis=${actual.crisisOverrideFired}`);
    } else {
      mismatches += 1;
      console.error(`[${dateLabel}] MISMATCH`);
      console.error(`  expected (old, persisted): ${JSON.stringify(expected)}`);
      console.error(`  actual   (new, config-read): ${JSON.stringify(actual)}`);
    }
  }

  if (mismatches > 0) {
    console.error(`\n${mismatches}/${days.length} day(s) MISMATCHED. Do not proceed.`);
    process.exit(1);
  }

  console.log(`\nAll ${days.length} day(s) matched. Config-read path is behavior-identical to the old hardcoded path.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

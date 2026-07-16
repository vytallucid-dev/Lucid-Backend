/* eslint-disable no-console */
/**
 * Compass v2 Phase 3 verification — read-only, writes nothing.
 *
 * Reports, for each live (isValidation=false) classification date on or
 * after the v2 activation date: raw_label (today's freshly computed
 * candidate), active_regime (persisted), pending_label (DERIVED from the
 * prior row's candidateRegime — Phase 3 stores no pending_label column;
 * see compass-classifier-logic.ts's resolveActiveRegime doc comment for the
 * soundness argument), pending_count (persistenceDaysCount), the `required`
 * threshold for that day (3 or 5, config-driven), and whether a flip
 * occurred (recomputed activeRegime != prior activeRegime).
 *
 * Read-only: does not call runCompassClassifier and does not write to
 * compass_classifications. It only reads what is already persisted and
 * recomputes classification in-memory using the live code path.
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
// V2_EFFECTIVE_FROM). Dates before this have old-shape compass_inputs rows.
const V2_ACTIVATION_DATE = new Date('2026-07-16');

const REGIME_SEVERITY: Record<Regime, number> = {
  'Risk-On': 0,
  Caution: 1,
  'Risk-Off': 2,
};

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
      `No live compass_classifications rows on or after v2 activation (${V2_ACTIVATION_DATE.toISOString().slice(0, 10)}) — nothing to verify yet.`,
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

    const inputsWithBand = inputs.map((r) => ({
      inputCode: r.inputCode,
      colorBand: r.colorBand as ColorBand,
    }));
    const voteWeights = sumVoteWeights(inputsWithBand, config);

    const inputsByCode = new Map(inputs.map((r) => [r.inputCode, r]));
    const vixRow = inputsByCode.get('VIX_5D_AVG');
    const hyRow = inputsByCode.get('HY_OAS');
    const crisis = checkCrisisOverride(
      {
        vixFiveDayAvg: vixRow ? decimalToNumber(vixRow.derivedValue) : null,
        hyOasLevel: hyRow ? decimalToNumber(hyRow.rawValue) : null,
      },
      config,
    );

    const rawLabel = determineCandidateRegime({ voteWeights, crisisFired: crisis.fired }, config);

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

    // Derive pending_label the same way resolveActiveRegime does internally:
    // prior.candidateRegime whenever prior.persistenceDaysCount > 0, else null.
    const pendingLabelBefore: Regime | null =
      prior && prior.persistenceDaysCount > 0 ? prior.candidateRegime : null;

    const activeBefore = prior?.activeRegime ?? 'Caution'; // bootstrap default
    const required =
      REGIME_SEVERITY[rawLabel] > REGIME_SEVERITY[activeBefore]
        ? config.persistence.daysToHigherSeverity
        : config.persistence.daysToLowerSeverity;

    const { activeRegime, persistenceDaysCount } = resolveActiveRegime(
      { candidateRegime: rawLabel, crisisFired: crisis.fired, prior },
      config,
    );

    const flipped = activeRegime !== activeBefore;

    console.log(`  raw_label=${rawLabel}  crisisFired=${crisis.fired}`);
    console.log(`  active_regime (before)=${activeBefore}  pending_label (before, derived)=${pendingLabelBefore ?? 'null'}  pending_count (before)=${prior?.persistenceDaysCount ?? 0}`);
    console.log(`  required=${crisis.fired ? 'n/a (crisis bypass)' : required} (severity raw=${REGIME_SEVERITY[rawLabel]} vs active=${REGIME_SEVERITY[activeBefore]})`);
    console.log(`  -> active_regime (after)=${activeRegime}  persistenceDaysCount (after)=${persistenceDaysCount}  ${flipped ? 'FLIPPED' : 'no flip'}`);

    const persisted = {
      candidateRegime: day.candidateRegime as Regime,
      activeRegime: day.activeRegime as Regime,
      persistenceDaysCount: day.persistenceDaysCount,
    };
    const matches =
      persisted.candidateRegime === rawLabel &&
      persisted.activeRegime === activeRegime &&
      persisted.persistenceDaysCount === persistenceDaysCount;
    console.log(`  matches persisted row: ${matches}`);
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

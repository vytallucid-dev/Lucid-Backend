/* eslint-disable no-console */
/**
 * Compass v2 Phase 2B verification — read-only, writes nothing.
 *
 * Extends Phase 2A's verify-compass-phase2a.ts with the 2s10s
 * inversion-episode detail that lives in YIELD_2S10S's stored subChecks
 * JSON (inversionStart, unInversionDate, insideRedWindow, jobsSubCheckBand),
 * and explicitly names WHICH of the 3 colour rules matched, so a flip from
 * v1's YELLOW to v2's GREEN can be attributed to a specific rule rather than
 * asserted by coincidence.
 *
 * Scoped the same way as Phase 2A: only live (isValidation=false)
 * classification dates ON OR AFTER the v2 activation date are examined —
 * pre-activation dates have old-shape compass_inputs rows.
 *
 * Read-only: does not call runCompassClassifier, does not call
 * ingestYieldCurveInput, and does not write to compass_classifications,
 * compass_inputs, or compass_curve_state. It only reads what is already
 * persisted and recomputes classification in-memory using the live code
 * path (compass-classifier-logic.ts).
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
// and are out of scope for this script. Phase 2B ships as part of the same
// v2 config row, so the same floor applies.
const V2_ACTIVATION_DATE = new Date('2026-07-16');

function decimalToNumber(d: unknown): number | null {
  if (d === null || d === undefined) return null;
  return Number((d as { toString(): string }).toString());
}

interface YieldCurveSubChecks {
  inversionStart: string | null;
  unInversionDate: string | null;
  insideRedWindow: boolean;
  jobsSubCheckBand: ColorBand;
}

function parseCurveSubChecks(subChecks: unknown): YieldCurveSubChecks | null {
  if (subChecks === null || typeof subChecks !== 'object') return null;
  const s = subChecks as Record<string, unknown>;
  if (typeof s.insideRedWindow !== 'boolean') return null;
  return {
    inversionStart: typeof s.inversionStart === 'string' ? s.inversionStart : null,
    unInversionDate: typeof s.unInversionDate === 'string' ? s.unInversionDate : null,
    insideRedWindow: s.insideRedWindow,
    jobsSubCheckBand: (s.jobsSubCheckBand as ColorBand) ?? 'YELLOW',
  };
}

/** Names which of evaluate2s10s's 3 rules produced `band`, for a human to audit. */
function explainCurveRule(
  t10y2y: number,
  delta30: number | null,
  curve: YieldCurveSubChecks,
  deltaFloor: number,
): string {
  if (curve.insideRedWindow && curve.jobsSubCheckBand !== 'GREEN') {
    return `rule 1 (inside red window [${curve.unInversionDate}], jobs=${curve.jobsSubCheckBand} != GREEN) -> RED`;
  }
  if (t10y2y >= 0 && delta30 !== null && delta30 >= deltaFloor) {
    return `rule 2 (t10y2y=${t10y2y} >= 0 AND delta30=${delta30} >= floor=${deltaFloor}) -> GREEN`;
  }
  return `rule 3 (fallthrough: t10y2y=${t10y2y}, delta30=${delta30}, insideRedWindow=${curve.insideRedWindow}) -> YELLOW`;
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

  const curveState = await prisma.compassCurveState.findUnique({ where: { isValidation: false } });
  console.log('=== compass_curve_state cache (current) ===');
  if (curveState) {
    console.log(`  computedForDate=${curveState.computedForDate.toISOString().slice(0, 10)}`);
    console.log(`  inversionStart=${curveState.inversionStart?.toISOString().slice(0, 10) ?? 'null'}`);
    console.log(`  unInversionDate=${curveState.unInversionDate?.toISOString().slice(0, 10) ?? 'null'}`);
  } else {
    console.log('  NO ROW — episode scan has not run yet (or found no episode ever). Not an error by itself.');
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

    const curveRow = inputsByCode.get('YIELD_2S10S');
    const curve = curveRow ? parseCurveSubChecks(curveRow.subChecks) : null;
    if (curveRow && curve) {
      const t10y2y = decimalToNumber(curveRow.rawValue) as number;
      const delta30 = decimalToNumber(curveRow.derivedValue);
      console.log('  --- YIELD_2S10S state-machine detail ---');
      console.log(`    t10y2y(t)=${t10y2y}  delta30=${delta30}`);
      console.log(`    inversionStart=${curve.inversionStart ?? 'null'}  unInversionDate=${curve.unInversionDate ?? 'null'}`);
      console.log(`    insideRedWindow=${curve.insideRedWindow}  jobsSubCheckBand=${curve.jobsSubCheckBand}`);
      console.log(`    matched: ${explainCurveRule(t10y2y, delta30, curve, config.yieldCurve.curve_delta30_floor)}`);
    } else if (curveRow) {
      console.log('  --- YIELD_2S10S subChecks did not parse as the v2 shape (old-shape row?) ---');
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

    console.log(matches ? '  -> UNCHANGED' : '  -> DIFFERS from persisted (explain via the input/rule detail above)');
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

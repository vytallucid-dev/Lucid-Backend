/* eslint-disable no-console */
/**
 * Compass v2 Phase 4 verification — read-only, writes nothing.
 *
 * Reports, for each live (isValidation=false) classification date on or
 * after the v2 activation date: VIX close, OAS delta5, USDJPY 5-day move,
 * both trigger evaluations, shock states + expiries, standard_active_regime,
 * and final_regime.
 *
 * Read-only: does not call runCompassClassifier, does not write to
 * compass_classifications or compass_shock_state. It only reads what is
 * already persisted (compass_inputs history + compass_classifications +
 * compass_shock_state) and recomputes in-memory using the live code path
 * (compass-classifier-logic.ts / compass-shock-layer.ts).
 */
import { prisma } from '@core/db/prisma';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import {
  determineCandidateRegime,
  resolveActiveRegime,
  sumVoteWeights,
  type Regime,
} from '@modules/edgefinder/services/compass/compass-classifier-logic';
import {
  evaluateTriggerA,
  evaluateTriggerB,
  type ShockObservation,
} from '@modules/edgefinder/services/compass/compass-shock-layer';
import type { ColorBand } from '@modules/edgefinder/services/compass/compass-bands';

const DAYS_TO_CHECK = Number(process.argv[2] ?? 10);

// Compass v2 Phase 2A activation date (see prisma/seed-compass-config.ts
// V2_EFFECTIVE_FROM). Dates before this have old-shape compass_inputs rows.
const V2_ACTIVATION_DATE = new Date('2026-07-16');
const SHOCK_HISTORY_DAYS_BACK = 30;

const EXPECTED_INPUT_CODES = [
  'VIX_5D_AVG',
  'HY_OAS',
  'YIELD_2S10S',
  'DXY_TREND',
  'VIX_TERM_STRUCTURE',
  'US_DATA_STACK',
] as const;

function decimalToNumber(d: unknown): number | null {
  if (d === null || d === undefined) return null;
  return Number((d as { toString(): string }).toString());
}

async function readInputSeries(
  inputCode: string,
  field: 'rawValue' | 'derivedValue',
  fromDate: Date,
  toDate: Date,
): Promise<ShockObservation[]> {
  const rows = await prisma.compassInput.findMany({
    where: {
      inputCode,
      isValidation: false,
      observationDate: { gte: fromDate, lte: toDate },
    },
    orderBy: { observationDate: 'asc' },
    select: { observationDate: true, rawValue: true, derivedValue: true },
  });
  const out: ShockObservation[] = [];
  for (const r of rows) {
    const raw = field === 'rawValue' ? r.rawValue : r.derivedValue;
    const value = decimalToNumber(raw);
    if (value !== null) out.push({ date: r.observationDate, value });
  }
  return out;
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

  const shockState = await prisma.compassShockState.findUnique({ where: { isValidation: false } });
  console.log('=== compass_shock_state cache (current) ===');
  if (shockState) {
    console.log(`  computedForDate=${shockState.computedForDate.toISOString().slice(0, 10)}`);
    console.log(`  shockAActive=${shockState.shockAActive}  shockAExpiry=${shockState.shockAExpiry?.toISOString().slice(0, 10) ?? 'null'}`);
    console.log(`  shockBActive=${shockState.shockBActive}  shockBExpiry=${shockState.shockBExpiry?.toISOString().slice(0, 10) ?? 'null'}`);
  } else {
    console.log('  NO ROW — shock layer has not run yet. Not an error by itself.');
  }

  const days = [...recentClassifications].reverse(); // ascending

  for (const day of days) {
    const dateLabel = day.classificationDate.toISOString().slice(0, 10);
    console.log(`\n=== ${dateLabel} ===`);

    const config = await compassConfigRepository.resolveForDate(day.classificationDate);
    const weightTotal = Object.values(config.weights).reduce((s, w) => s + w, 0);
    console.log(`  config weights sum: ${weightTotal} ${weightTotal === 8.0 ? '(OK)' : '(MISMATCH — STOP)'}`);

    const inputs = await prisma.compassInput.findMany({
      where: {
        observationDate: day.classificationDate,
        isValidation: false,
        inputCode: { in: [...EXPECTED_INPUT_CODES] },
      },
    });

    if (inputs.length < EXPECTED_INPUT_CODES.length) {
      console.log(`  SKIP — only ${inputs.length}/${EXPECTED_INPUT_CODES.length} voting inputs present`);
      continue;
    }

    const inputsWithBand = inputs.map((r) => ({
      inputCode: r.inputCode,
      colorBand: r.colorBand as ColorBand,
    }));
    const voteWeights = sumVoteWeights(inputsWithBand, config);
    const rawLabel = determineCandidateRegime({ voteWeights }, config);

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

    const { activeRegime: standardActiveRegime, persistenceDaysCount } = resolveActiveRegime(
      { candidateRegime: rawLabel, prior },
      config,
    );

    const historyFrom = new Date(day.classificationDate);
    historyFrom.setUTCDate(historyFrom.getUTCDate() - SHOCK_HISTORY_DAYS_BACK);

    const [vixCloses, vix5dAvgs, oasLevels, usdJpyCloses] = await Promise.all([
      readInputSeries('VIX_5D_AVG', 'rawValue', historyFrom, day.classificationDate),
      readInputSeries('VIX_5D_AVG', 'derivedValue', historyFrom, day.classificationDate),
      readInputSeries('HY_OAS', 'rawValue', historyFrom, day.classificationDate),
      readInputSeries('USDJPY_PRICE', 'rawValue', historyFrom, day.classificationDate),
    ]);

    const triggerA = evaluateTriggerA(day.classificationDate, {
      vixCloses,
      oasLevels,
      vixThreshold: config.shockLayer.shock_a_vix_threshold,
      oasDelta5Threshold: config.shockLayer.shock_a_oas_delta5,
    });
    const triggerB = evaluateTriggerB(day.classificationDate, {
      usdJpyCloses,
      vix5dAvgs,
      usdJpyMove5Threshold: config.shockLayer.shock_b_usdjpy_move5,
    });

    const vixIdx = vixCloses.findIndex((o) => o.date.getTime() === day.classificationDate.getTime());
    const oasIdx = oasLevels.findIndex((o) => o.date.getTime() === day.classificationDate.getTime());
    const jpyIdx = usdJpyCloses.findIndex((o) => o.date.getTime() === day.classificationDate.getTime());
    const vixClose = vixIdx !== -1 ? vixCloses[vixIdx].value : null;
    const oasDelta5 = oasIdx >= 5 ? oasLevels[oasIdx].value - oasLevels[oasIdx - 5].value : null;
    const jpyMove5 = jpyIdx >= 5 ? usdJpyCloses[jpyIdx].value / usdJpyCloses[jpyIdx - 5].value - 1 : null;

    console.log(`  VIX close(t)=${vixClose ?? 'n/a'}  OAS delta5=${oasDelta5 ?? 'n/a'}  USDJPY 5d move=${jpyMove5 ?? 'n/a'}`);
    console.log(`  Trigger A fired=${triggerA.fired}  Trigger B fired=${triggerB.fired}`);

    const persistedShockA = day.shockAActive;
    const persistedShockB = day.shockBActive;
    const finalRegime = day.finalRegime;

    console.log(`  standard_active_regime=${standardActiveRegime} (persistenceDaysCount=${persistenceDaysCount})`);
    console.log(`  persisted: shockAActive=${persistedShockA}  shockBActive=${persistedShockB}  finalRegime=${finalRegime || '(empty — pre-Phase-4 row)'}`);

    const expectedFinal = persistedShockA ? 'Risk-Off' : standardActiveRegime;
    const finalMatches = finalRegime === expectedFinal;
    console.log(`  expected final_regime given persisted shockAActive: ${expectedFinal} — ${finalMatches ? 'MATCHES' : 'MISMATCH'}`);
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

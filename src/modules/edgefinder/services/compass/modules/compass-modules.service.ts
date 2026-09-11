import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';
import { compassShockStateRepository } from '@core/repositories/compass-shock-state.repository';
import { isUsMarketTradingDay } from '@core/utils/us-market-calendar';
import { buildReadings } from './readings-builder.service';
import { buildModuleStates } from './modules';
import { synthesise, assertTraceable } from './synthesis';
import type { ModuleReading, ModuleState, Synthesis } from './module-types';

/**
 * Layer 1 + layer 2 for a date: build the readings, derive the five module
 * states, synthesise, verify traceability, persist.
 *
 * Runs AFTER the classifier, because the module layer reports the vote the
 * classifier actually used rather than re-deriving it. If the two could
 * disagree, the page would be able to state a rule the backend did not apply —
 * which is exactly the defect the old frontend had, recomputing the vote rule in
 * the browser.
 */

export interface RunModulesResult {
  status: 'success' | 'skipped_non_trading_day' | 'skipped_no_classification' | 'failed';
  classificationDate: Date;
  readingCount?: number;
  sentenceCount?: number;
  disagreementCount?: number;
  reason?: string;
}

export async function runCompassModules(
  forDate?: Date,
  isValidation = false,
  researchTag = '',
): Promise<RunModulesResult> {
  const now = new Date();
  const classificationDate =
    forDate ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (!isUsMarketTradingDay(classificationDate)) {
    return { status: 'skipped_non_trading_day', classificationDate };
  }

  try {
    const config = await compassConfigRepository.resolveForDate(classificationDate);

    const row = await prisma.compassClassification.findFirst({
      where: { classificationDate, isValidation, isCurrent: true },
    });

    if (!row) {
      return {
        status: 'skipped_no_classification',
        classificationDate,
        reason: 'no classification for this date — run the classifier first',
      };
    }

    const readings = await buildReadings(classificationDate, config, isValidation);
    const states = buildModuleStates(readings);

    const shock = await compassShockStateRepository.get(isValidation, researchTag);
    const prior = await compassClassificationsRepository.getMostRecentBefore(
      classificationDate,
      isValidation,
    );

    // Trading days of live history so far — layer 2 must degrade rather than
    // render a comparison against one data point.
    const historyAgg = await prisma.compassClassification.aggregate({
      where: { isValidation, isCurrent: true, isTradingDay: true },
      _count: { _all: true },
      _min: { classificationDate: true },
    });

    const totalWeight = Object.values(config.weights).reduce((s, w) => s + w, 0);
    const synthesis: Synthesis = synthesise({
      readings,
      states,
      regime: {
        active: row.activeRegime,
        candidate: row.candidateRegime,
        final: row.finalRegime && row.finalRegime.length > 0 ? row.finalRegime : row.activeRegime,
        green: Number(row.totalGreenWeight.toString()),
        yellow: Number(row.totalYellowWeight.toString()),
        red: Number(row.totalRedWeight.toString()),
        total: totalWeight,
        pendingLabel:
          row.persistenceDaysCount > 0 ? row.candidateRegime : null,
        pendingCount: row.persistenceDaysCount,
        required:
          prior && row.candidateRegime !== prior.activeRegime
            ? config.persistence.daysToHigherSeverity
            : config.persistence.daysToLowerSeverity,
        shockAActive: row.shockAActive,
        shockAExpiry: shock?.shockAExpiry?.toISOString().slice(0, 10) ?? null,
      },
      historyDays: historyAgg._count._all,
      historyStartDate:
        historyAgg._min.classificationDate?.toISOString().slice(0, 10) ?? null,
    });

    // Refuses to persist a claim with no supporting reading.
    assertTraceable(synthesis, readings);

    await persist(classificationDate, readings, states, synthesis, {
      configVersionLabel: config.versionLabel ?? null,
      isValidation,
      researchTag,
    });

    logger.info(
      {
        classificationDate: classificationDate.toISOString().slice(0, 10),
        readings: readings.length,
        sentences: synthesis.sentences.length,
        disagreements: synthesis.disagreements.length,
      },
      'Compass modules: layer 1 + layer 2 persisted',
    );

    return {
      status: 'success',
      classificationDate,
      readingCount: readings.length,
      sentenceCount: synthesis.sentences.length,
      disagreementCount: synthesis.disagreements.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { classificationDate: classificationDate.toISOString().slice(0, 10), message },
      'Compass modules run failed',
    );
    return { status: 'failed', classificationDate, reason: message };
  }
}

async function persist(
  classificationDate: Date,
  readings: ModuleReading[],
  states: ModuleState[],
  synthesis: Synthesis,
  meta: { configVersionLabel: string | null; isValidation: boolean; researchTag: string },
): Promise<void> {
  const { configVersionLabel, isValidation, researchTag } = meta;

  await prisma.$transaction([
    // Readings are fully recomputable for a date, so replace rather than merge:
    // a reading that stops being produced must disappear, not linger.
    prisma.compassModuleReading.deleteMany({
      where: { classificationDate, isValidation, researchTag },
    }),
    prisma.compassModuleReading.createMany({
      data: readings.map((r) => ({
        classificationDate,
        moduleCode: r.moduleCode,
        readingCode: r.readingCode,
        colorBand: r.colorBand,
        isVoting: r.isVoting,
        weight: r.weight === null ? null : new Prisma.Decimal(r.weight),
        stateLabel: r.stateLabel,
        valueNumeric:
          r.valueNumeric === null || !Number.isFinite(r.valueNumeric)
            ? null
            : new Prisma.Decimal(r.valueNumeric.toFixed(6)),
        valueText: r.valueText,
        unit: r.unit,
        sourceCode: r.sourceCode,
        sourceAsOf: r.sourceAsOf,
        stalenessState: r.stalenessState,
        stalenessDays: r.stalenessDays,
        explanation: (r.explanation ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        configVersionLabel,
        researchTag,
        isValidation,
      })),
    }),
    prisma.compassModuleState.deleteMany({
      where: { classificationDate, isValidation, researchTag },
    }),
    prisma.compassModuleState.createMany({
      data: states.map((s) => ({
        classificationDate,
        moduleCode: s.moduleCode,
        verdictBand: s.verdictBand,
        stateLabel: s.stateLabel,
        headline: s.headline as unknown as Prisma.InputJsonValue,
        readingCodes: s.readingCodes as unknown as Prisma.InputJsonValue,
        configVersionLabel,
        researchTag,
        isValidation,
      })),
    }),
    prisma.compassSynthesis.deleteMany({
      where: { classificationDate, isValidation, researchTag },
    }),
    prisma.compassSynthesis.create({
      data: {
        classificationDate,
        sentences: synthesis.sentences as unknown as Prisma.InputJsonValue,
        disagreements: synthesis.disagreements as unknown as Prisma.InputJsonValue,
        configVersionLabel,
        researchTag,
        isValidation,
      },
    }),
  ]);
}

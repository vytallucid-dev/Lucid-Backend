import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { logger } from '@core/utils/logger';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { getPriorRateLevel } from './rate-decision.helpers';

const JOB_NAME = 'manual_data_entry';

export interface ManualEntryInput {
  indicatorCode: string;
  observationDate: Date;
  actual: number;
  forecast: number | null;
  previous: number | null;
  notes: string | null;
  triggeredBy: string | null;
}

export interface ManualEntryResult {
  dataPointId: string;
  action: 'inserted' | 'revised' | 'skipped';
  indicator: { code: string; name: string };
  observationDate: Date;
  value: number;
  isRateDecision: boolean;
  rateLevel?: number;
  forecastValue: number | null;
  previousValue: number | null;
  notes: string | null;
}

export async function ingestManualEntry(
  input: ManualEntryInput,
): Promise<ManualEntryResult> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: input.indicatorCode },
    select: { id: true, code: true, name: true, dataSource: true },
  });

  if (!indicator) {
    throw new AppError(
      404,
      `Indicator ${input.indicatorCode} not found`,
      'INDICATOR_NOT_FOUND',
      { indicatorCode: input.indicatorCode },
    );
  }

  if (indicator.dataSource === 'fred') {
    throw new AppError(
      400,
      `Indicator ${input.indicatorCode} is sourced from FRED (auto-fetched). Manual entry not allowed.`,
      'INDICATOR_NOT_MANUAL_ELIGIBLE',
      { indicatorCode: input.indicatorCode, dataSource: indicator.dataSource },
    );
  }

  const isRateDecision = indicator.code.endsWith('_RATE');

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType: 'manual',
    triggeredBy: input.triggeredBy ?? null,
    metadata: {
      indicatorCode: input.indicatorCode,
      observationDate: input.observationDate.toISOString(),
      isRateDecision,
    },
  });

  try {
    const enteredAt = new Date().toISOString();

    if (isRateDecision) {
      const priorRate = await getPriorRateLevel(indicator.id, input.observationDate);
      const firstRelease = priorRate === null;
      const bpsChange = firstRelease ? 0 : (input.actual - priorRate) * 100;

      const sourceMetadata: Prisma.InputJsonObject = {
        manualEntry: true,
        rate_level: input.actual,
        ...(firstRelease ? { first_release: true } : {}),
        notes: input.notes ?? null,
        enteredAt,
        ...(input.triggeredBy ? { enteredBy: input.triggeredBy } : {}),
      };

      const upsert = await dataPointsRepository.upsert({
        indicatorId: indicator.id,
        observationDate: input.observationDate,
        value: bpsChange,
        forecastValue: null,
        previousValue: null,
        source: 'manual',
        sourceMetadata,
        fetchedVia: log.id,
        notes: input.notes ?? null,
      });

      await dataFetchLogRepository.complete({
        logId: log.id,
        status: 'success',
        rowsInserted: upsert.action === 'inserted' ? 1 : 0,
        rowsUpdated: upsert.action === 'revised' ? 1 : 0,
        rowsSkipped: upsert.action === 'skipped' ? 1 : 0,
      });

      logger.info(
        {
          indicatorCode: indicator.code,
          observationDate: input.observationDate.toISOString(),
          rateLevel: input.actual,
          priorRate,
          bpsChange,
          firstRelease,
          action: upsert.action,
        },
        'Manual rate-decision entry recorded',
      );

      return {
        dataPointId: upsert.dataPoint?.id ?? '',
        action: upsert.action,
        indicator: { code: indicator.code, name: indicator.name },
        observationDate: input.observationDate,
        value: bpsChange,
        isRateDecision: true,
        rateLevel: input.actual,
        forecastValue: null,
        previousValue: null,
        notes: input.notes,
      };
    }

    const sourceMetadata: Prisma.InputJsonObject = {
      manualEntry: true,
      notes: input.notes ?? null,
      enteredAt,
      ...(input.triggeredBy ? { enteredBy: input.triggeredBy } : {}),
    };

    const upsert = await dataPointsRepository.upsert({
      indicatorId: indicator.id,
      observationDate: input.observationDate,
      value: input.actual,
      forecastValue: input.forecast,
      previousValue: input.previous,
      source: 'manual',
      sourceMetadata,
      fetchedVia: log.id,
      notes: input.notes ?? null,
    });

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted: upsert.action === 'inserted' ? 1 : 0,
      rowsUpdated: upsert.action === 'revised' ? 1 : 0,
      rowsSkipped: upsert.action === 'skipped' ? 1 : 0,
    });

    logger.info(
      {
        indicatorCode: indicator.code,
        observationDate: input.observationDate.toISOString(),
        value: input.actual,
        forecast: input.forecast,
        previous: input.previous,
        action: upsert.action,
      },
      'Manual data entry recorded',
    );

    return {
      dataPointId: upsert.dataPoint?.id ?? '',
      action: upsert.action,
      indicator: { code: indicator.code, name: indicator.name },
      observationDate: input.observationDate,
      value: input.actual,
      isRateDecision: false,
      forecastValue: input.forecast,
      previousValue: input.previous,
      notes: input.notes,
    };
  } catch (err) {
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: {
        message: err instanceof Error ? err.message : String(err),
      } as Prisma.InputJsonValue,
    });
    throw err;
  }
}

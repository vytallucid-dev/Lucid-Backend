import { Indicator } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { validateValue } from './manual-input.validators';

export interface ManualInputParams {
  indicatorCode: string;
  observationDate: Date;
  value: number;
  notes?: string | null;
  allowOverwrite?: boolean;
  triggeredBy?: string | null;
  sourceMetadata?: Record<string, unknown>;
}

export interface ManualInputResult {
  indicatorCode: string;
  logId: string;
  action: 'inserted' | 'revised' | 'skipped';
  observationDate: string;
  value: number;
}

async function loadManualIndicator(indicatorCode: string): Promise<Indicator> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: indicatorCode },
  });

  if (!indicator) {
    throw new AppError(404, `Indicator not found: ${indicatorCode}`, 'INDICATOR_NOT_FOUND');
  }

  if (!indicator.isActive) {
    throw new AppError(400, `Indicator ${indicatorCode} is not active`, 'INDICATOR_INACTIVE');
  }

  if (indicator.dataSource !== 'manual') {
    throw new AppError(
      400,
      `Indicator ${indicatorCode} does not accept manual input (data_source=${indicator.dataSource})`,
      'INVALID_DATA_SOURCE',
    );
  }

  return indicator;
}

function validateObservationDate(date: Date): void {
  const now = new Date();
  now.setUTCHours(23, 59, 59, 999); // allow today
  if (date.getTime() > now.getTime()) {
    throw new AppError(400, `observation_date cannot be in the future`, 'INVALID_OBSERVATION_DATE');
  }

  // Sanity floor: nothing before 2000
  const floor = new Date('2000-01-01T00:00:00.000Z');
  if (date.getTime() < floor.getTime()) {
    throw new AppError(
      400,
      `observation_date must be on or after 2000-01-01`,
      'INVALID_OBSERVATION_DATE',
    );
  }
}

/**
 * Manually enter a data point for an indicator.
 * Uses the same vintage-aware upsert flow as the FRED fetcher.
 *
 * If `allowOverwrite` is true, forces a new vintage even when the value
 * matches what we already have (use case: re-affirming a correction).
 */
export async function submitManualInput(params: ManualInputParams): Promise<ManualInputResult> {
  const indicator = await loadManualIndicator(params.indicatorCode);
  validateObservationDate(params.observationDate);

  const validationResult = validateValue(params.indicatorCode, params.value);
  if (!validationResult.valid) {
    throw new AppError(400, validationResult.reason ?? 'Invalid value', 'VALUE_VALIDATION_FAILED', {
      indicatorCode: params.indicatorCode,
      value: params.value,
    });
  }

  const log = await dataFetchLogRepository.start({
    jobName: `manual_input_${indicator.code.toLowerCase()}`,
    triggerType: 'manual',
    triggeredBy: params.triggeredBy ?? null,
    targetDateFrom: params.observationDate,
    targetDateTo: params.observationDate,
    metadata: {
      indicatorCode: indicator.code,
      value: params.value,
      allowOverwrite: params.allowOverwrite ?? false,
    },
  });

  try {
    let result: { action: 'inserted' | 'revised' | 'skipped'; dataPoint: { id: string } | null };

    if (params.allowOverwrite) {
      // Override path: flip any existing current row, then insert new vintage with 'revised' flag.
      // We do this in a single transaction to keep history consistent.
      result = await prisma.$transaction(async (tx) => {
        const existing = await tx.dataPoint.findFirst({
          where: {
            indicatorId: indicator.id,
            observationDate: params.observationDate,
            isCurrent: true,
          },
        });

        if (existing) {
          await tx.dataPoint.update({
            where: { id: existing.id },
            data: { isCurrent: false },
          });
        }

        const inserted = await tx.dataPoint.create({
          data: {
            indicatorId: indicator.id,
            observationDate: params.observationDate,
            value: params.value,
            isCurrent: true,
            source: 'manual',
            sourceMetadata: {
              enteredBy: params.triggeredBy ?? 'system',
              allowOverwrite: true,
              forcedOverride: existing !== null,
              ...(params.sourceMetadata ?? {}),
            },
            fetchedVia: log.id,
            dataQualityFlag: existing ? 'revised' : null,
            notes: params.notes ?? null,
            createdBy: params.triggeredBy ?? null,
          },
        });

        return {
          action: existing ? 'revised' : 'inserted',
          dataPoint: inserted,
        };
      });
    } else {
      // Normal path: use shared upsert (same as FRED fetcher)
      result = await dataPointsRepository.upsert({
        indicatorId: indicator.id,
        observationDate: params.observationDate,
        value: params.value,
        source: 'manual',
        sourceMetadata: {
          enteredBy: params.triggeredBy ?? 'system',
          allowOverwrite: false,
          ...(params.sourceMetadata ?? {}),
        },
        fetchedVia: log.id,
        notes: params.notes ?? null,
        createdBy: params.triggeredBy ?? null,
      });
    }

    const action = result.action;
    const rowsInserted = action === 'inserted' ? 1 : 0;
    const rowsUpdated = action === 'revised' ? 1 : 0;
    const rowsSkipped = action === 'skipped' ? 1 : 0;

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
    });

    logger.info(
      {
        indicatorCode: indicator.code,
        observationDate: params.observationDate.toISOString().slice(0, 10),
        value: params.value,
        action,
      },
      'Manual input recorded',
    );

    return {
      indicatorCode: indicator.code,
      logId: log.id,
      action,
      observationDate: params.observationDate.toISOString().slice(0, 10),
      value: params.value,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof AppError ? err.code : 'UNKNOWN',
    };
    logger.error({ ...errorPayload, indicatorCode: indicator.code }, 'Manual input failed');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });

    throw err;
  }
}

import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import { orderedCompassInputs } from './compass-input-registry';

const JOB_NAME = 'compass_inputs_daily_fetch';

export interface CompassInputOrchestratorResult {
  logId: string;
  status: 'success' | 'partial' | 'failed';
  inputsSucceeded: string[];
  inputsFailed: { code: string; error: string }[];
  durationMs: number;
}

function todayUtcDateOnly(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export async function runAllCompassInputs(
  triggerType: 'cron' | 'manual',
  triggeredBy?: string | null,
  forDate?: Date,
  isValidation: boolean = false,
): Promise<CompassInputOrchestratorResult> {
  const observationDate = forDate ?? todayUtcDateOnly();
  const startedAt = Date.now();
  const config = await compassConfigRepository.resolveForDate(observationDate);

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType,
    triggeredBy: triggeredBy ?? null,
    metadata: {
      observationDate: observationDate.toISOString().slice(0, 10),
      isValidation,
    },
  });

  const inputsSucceeded: string[] = [];
  const inputsFailed: { code: string; error: string }[] = [];

  for (const input of orderedCompassInputs()) {
    try {
      await input.fn(observationDate, config, isValidation);
      inputsSucceeded.push(input.code);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      inputsFailed.push({ code: input.code, error: message });
      logger.error(
        { inputCode: input.code, message, isValidation },
        'Compass input ingestion failed',
      );
    }
  }

  const status: 'success' | 'partial' | 'failed' =
    inputsFailed.length === 0
      ? 'success'
      : inputsSucceeded.length === 0
        ? 'failed'
        : 'partial';

  const durationMs = Date.now() - startedAt;

  await dataFetchLogRepository.complete({
    logId: log.id,
    status,
    rowsInserted: inputsSucceeded.length,
    rowsUpdated: 0,
    rowsSkipped: inputsFailed.length,
    errors:
      inputsFailed.length > 0
        ? (inputsFailed as unknown as object)
        : undefined,
    metadata: {
      observationDate: observationDate.toISOString().slice(0, 10),
      isValidation,
      inputsSucceeded,
      inputsFailed,
      durationMs,
    },
  });

  logger.info(
    {
      jobName: JOB_NAME,
      status,
      inputsSucceeded,
      failedCount: inputsFailed.length,
      durationMs,
      isValidation,
    },
    'Compass orchestrator complete',
  );

  return {
    logId: log.id,
    status,
    inputsSucceeded,
    inputsFailed,
    durationMs,
  };
}

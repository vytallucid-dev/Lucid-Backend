import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { ingestVixInput } from './inputs/vix-input.service';
import { ingestHyOasInput } from './inputs/hy-oas-input.service';
import { ingestYieldCurveInput } from './inputs/yield-curve-input.service';
import { ingestDxyTrendInput } from './inputs/dxy-trend-input.service';
import { ingestGoldDxyCorrInput } from './inputs/gold-dxy-corr-input.service';
import { ingestUsDataStackInput } from './inputs/us-data-stack-input.service';

const JOB_NAME = 'compass_inputs_daily_fetch';

type IngestFn = (observationDate: Date, isValidation?: boolean) => Promise<void>;

interface InputDescriptor {
  code: string;
  fn: IngestFn;
}

const INPUTS: InputDescriptor[] = [
  { code: 'VIX_5D_AVG', fn: ingestVixInput },
  { code: 'HY_OAS', fn: ingestHyOasInput },
  { code: 'YIELD_2S10S', fn: ingestYieldCurveInput },
  { code: 'DXY_TREND', fn: ingestDxyTrendInput },
  { code: 'GOLD_DXY_CORR', fn: ingestGoldDxyCorrInput },
  { code: 'US_DATA_STACK', fn: ingestUsDataStackInput },
];

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

  for (const input of INPUTS) {
    try {
      await input.fn(observationDate, isValidation);
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

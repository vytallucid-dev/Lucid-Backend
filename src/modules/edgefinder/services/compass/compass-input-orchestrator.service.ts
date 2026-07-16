import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import { ingestVixInput } from './inputs/vix-input.service';
import { ingestHyOasInput } from './inputs/hy-oas-input.service';
import { ingestYieldCurveInput } from './inputs/yield-curve-input.service';
import { ingestDxyTrendInput } from './inputs/dxy-trend-input.service';
import { ingestVixTermStructureInput } from './inputs/vix-term-structure-input.service';
import { ingestUsDataStackInput } from './inputs/us-data-stack-input.service';
import { ingestUsdJpyPriceInput } from './inputs/usdjpy-price-input.service';
import { ingestUs02yCloseInput } from './inputs/us02y-close-input.service';
import type { CompassConfigDefinition } from './compass-config.types';

const JOB_NAME = 'compass_inputs_daily_fetch';

type IngestFn = (
  observationDate: Date,
  config: CompassConfigDefinition,
  isValidation?: boolean,
) => Promise<void>;

interface InputDescriptor {
  code: string;
  fn: IngestFn;
}

// US_DATA_STACK MUST run before YIELD_2S10S: the curve input (Phase 2B)
// reads US_DATA_STACK's persisted Jobs sub-check for the same observation
// date, so its compass_inputs row must already exist when the curve input
// runs. This list is executed sequentially (see the for-loop below), so
// order here is load-bearing.
//
// USDJPY_PRICE (Phase 4) is Shock Layer plumbing, not one of the six voting
// inputs — ingestUsdJpyPriceInput takes no `config` param since it computes
// nothing config-driven (no colorBand logic), so it's wrapped to match
// IngestFn's shape.
const INPUTS: InputDescriptor[] = [
  { code: 'VIX_5D_AVG', fn: ingestVixInput },
  { code: 'HY_OAS', fn: ingestHyOasInput },
  { code: 'DXY_TREND', fn: ingestDxyTrendInput },
  { code: 'VIX_TERM_STRUCTURE', fn: ingestVixTermStructureInput },
  { code: 'US_DATA_STACK', fn: ingestUsDataStackInput },
  { code: 'YIELD_2S10S', fn: ingestYieldCurveInput },
  { code: 'USDJPY_PRICE', fn: (date, _config, isValidation) => ingestUsdJpyPriceInput(date, isValidation) },
  // US02Y_CLOSE (Phase 6) is rate-gate plumbing, not a voting input — same
  // config-less shape as USDJPY_PRICE.
  { code: 'US02Y_CLOSE', fn: (date, _config, isValidation) => ingestUs02yCloseInput(date, isValidation) },
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

  for (const input of INPUTS) {
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

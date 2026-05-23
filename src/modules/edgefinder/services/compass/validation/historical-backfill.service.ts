import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { ingestVixInput } from '../inputs/vix-input.service';
import { ingestHyOasInput } from '../inputs/hy-oas-input.service';
import { ingestYieldCurveInput } from '../inputs/yield-curve-input.service';
import { ingestDxyTrendInput } from '../inputs/dxy-trend-input.service';
import { ingestGoldDxyCorrInput } from '../inputs/gold-dxy-corr-input.service';
import { ingestUsDataStackInput } from '../inputs/us-data-stack-input.service';
import { runCompassClassifier } from '../compass-classifier.service';

const JOB_NAME = 'compass_validation_backfill';

/**
 * Sleep between trading days during a backfill. Keeps the FRED public CDN
 * happy — bursting ~6 requests/day with no gap was triggering 403 throttle
 * responses across hundreds of days. Live cron does not use this delay.
 */
const INTER_DAY_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BackfillWindow {
  windowName: string;
  startDate: Date;
  endDate: Date;
}

export interface BackfillResult {
  windowName: string;
  logId: string;
  totalTradingDays: number;
  inputsBackfilled: number;
  classificationsRun: number;
  errors: Array<{ date: string; error: string }>;
  durationMs: number;
}

type IngestFn = (observationDate: Date, isValidation?: boolean) => Promise<void>;

const INPUT_FNS: Array<{ code: string; fn: IngestFn }> = [
  { code: 'VIX_5D_AVG', fn: ingestVixInput },
  { code: 'HY_OAS', fn: ingestHyOasInput },
  { code: 'YIELD_2S10S', fn: ingestYieldCurveInput },
  { code: 'DXY_TREND', fn: ingestDxyTrendInput },
  { code: 'GOLD_DXY_CORR', fn: ingestGoldDxyCorrInput },
  { code: 'US_DATA_STACK', fn: ingestUsDataStackInput },
];

/**
 * Generate trading days (Mon-Fri) between start and end inclusive, ascending.
 * Holidays are best-effort skipped via downstream data availability rather
 * than a holiday calendar.
 */
export function generateTradingDays(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push(new Date(cursor));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Backfill all 6 Compass inputs for a date range and run the classifier for
 * each trading day in order.
 *
 * Two-level concurrency strategy:
 *   - Day-to-day: STRICTLY sequential. The classifier's persistence logic
 *     reads "yesterday's" classification, so today's run depends on
 *     yesterday's having been committed.
 *   - Within a day: the 6 input services run in parallel (Promise.allSettled)
 *     because they're independent fetches.
 *
 * If any input fails for a day, the classifier is skipped for that day, the
 * error is logged, and the backfill continues with the next day.
 */
export async function backfillWindow(
  window: BackfillWindow,
  triggeredBy: string | null = null,
): Promise<BackfillResult> {
  const startedAt = Date.now();
  const tradingDays = generateTradingDays(window.startDate, window.endDate);

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType: 'backfill',
    triggeredBy,
    targetDateFrom: window.startDate,
    targetDateTo: window.endDate,
    metadata: {
      windowName: window.windowName,
      tradingDaysExpected: tradingDays.length,
    },
  });

  const errors: Array<{ date: string; error: string }> = [];
  let inputsBackfilled = 0;
  let classificationsRun = 0;

  for (let i = 0; i < tradingDays.length; i += 1) {
    const day = tradingDays[i];
    const dayLabel = day.toISOString().slice(0, 10);

    if (i > 0) {
      await sleep(INTER_DAY_DELAY_MS);
    }

    const inputResults = await Promise.allSettled(
      INPUT_FNS.map((d) => d.fn(day, true)),
    );

    const failed = inputResults
      .map((r, i) => ({ result: r, code: INPUT_FNS[i].code }))
      .filter((x) => x.result.status === 'rejected');

    const succeededCount = inputResults.length - failed.length;
    inputsBackfilled += succeededCount;

    if (failed.length > 0) {
      const reasons = failed
        .map((f) => {
          const reason = (f.result as PromiseRejectedResult).reason;
          const msg = reason instanceof Error ? reason.message : String(reason);
          return `${f.code}: ${msg}`;
        })
        .join('; ');
      errors.push({ date: dayLabel, error: reasons });
      logger.warn(
        { windowName: window.windowName, date: dayLabel, reasons },
        'Compass backfill: inputs failed for day, skipping classifier',
      );
      continue;
    }

    try {
      await runCompassClassifier('manual', triggeredBy, day, true);
      classificationsRun += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ date: dayLabel, error: `classifier: ${msg}` });
      logger.error(
        { windowName: window.windowName, date: dayLabel, msg },
        'Compass backfill: classifier failed for day',
      );
    }
  }

  const durationMs = Date.now() - startedAt;
  const status = errors.length === 0 ? 'success' : 'partial';

  await dataFetchLogRepository.complete({
    logId: log.id,
    status,
    rowsInserted: inputsBackfilled,
    rowsUpdated: 0,
    rowsSkipped: errors.length,
    errors: errors.length > 0 ? (errors as unknown as object) : undefined,
    metadata: {
      windowName: window.windowName,
      tradingDaysExpected: tradingDays.length,
      inputsBackfilled,
      classificationsRun,
      errorCount: errors.length,
      durationMs,
    },
  });

  logger.info(
    {
      windowName: window.windowName,
      tradingDays: tradingDays.length,
      inputsBackfilled,
      classificationsRun,
      errorCount: errors.length,
      durationMs,
    },
    'Compass backfill window complete',
  );

  return {
    windowName: window.windowName,
    logId: log.id,
    totalTradingDays: tradingDays.length,
    inputsBackfilled,
    classificationsRun,
    errors,
    durationMs,
  };
}

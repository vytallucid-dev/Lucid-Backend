import { logger } from '@core/utils/logger';
import { generateTradingDays } from '@core/utils/us-market-calendar';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import { runCompassClassifier } from '../compass-classifier.service';
import { orderedCompassInputs } from '../compass-input-registry';

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

/**
 * Trading days between start and end inclusive, ascending.
 *
 * Phase C: this was a weekday-only filter whose own comment conceded that
 * "holidays are best-effort skipped via downstream data availability rather
 * than a holiday calendar". They were not skipped: Phase C Stage 0 confirmed
 * the live classifier wrote full classifications on Juneteenth 2026,
 * 3 July 2026 and Labor Day 2026, because the Phase 5 forward-fill makes all
 * six inputs look present on a closed market.
 *
 * The real calendar now lives in `@core/utils/us-market-calendar` (rule-derived
 * NYSE/SIFMA holidays plus an explicit list of unscheduled closures). This
 * export is kept as a re-export so the five input services and the classifier
 * that import it from here keep working unchanged; new code should import from
 * the util directly. Production code importing from a `validation/` folder was
 * always a wart — this is the first half of unwinding it.
 */
export { generateTradingDays };

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

    const dayConfig = await compassConfigRepository.resolveForDate(day);

    // Phase C: run in the registry's resolved dependency order, strictly
    // sequentially. Previously this ran US_DATA_STACK first and then the rest in
    // parallel, and attributed failures by zipping the settled results against a
    // DIFFERENTLY-ordered list — which happened to line up, but only by luck.
    // Sequential execution costs a little latency on a backfill and removes both
    // the ordering hazard and the mis-attribution.
    const descriptors = orderedCompassInputs();
    const inputResults: PromiseSettledResult<void>[] = [];
    for (const d of descriptors) {
      inputResults.push(
        await Promise.allSettled([d.fn(day, dayConfig, true)]).then((r) => r[0]),
      );
    }

    const failed = inputResults
      .map((r, i) => ({ result: r, code: descriptors[i].code }))
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

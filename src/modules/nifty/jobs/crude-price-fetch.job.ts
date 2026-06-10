import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { fetchCrudeBrentIndicator } from '@modules/nifty/services/crude-price-indicator.service';
import { isJobRunning } from './job-guard';

const JOB_NAME = 'crude_price_fetch';
const CONCURRENT_GUARD_MINUTES = 5;

/**
 * Daily Crude Price API fetch handler for NIFTY Brent (Ind 11). Wraps
 * `fetchCrudeBrentIndicator` with an orchestrator-level fetch_log entry
 * (`crude_price_fetch`, separate from the per-indicator `fetch_crude_brent` row
 * the underlying service writes). The orchestrator row is what the
 * concurrent-execution guard checks. One API call per run — the client's daily
 * cap and the provider's 100/month free quota both have ample headroom.
 *
 * Brent moved off EODHD's FRED-routed commodity feed (which lagged) to this
 * market-sourced /latest endpoint. DXY and USD/INR stay on EODHD.
 *
 * Called by BOTH the cron registration below and the manual /api/admin/jobs/run
 * trigger (job_name 'crude_price_fetch') — one job function, two callers.
 */
export async function runCrudeBrentFetch(): Promise<void> {
  // Concurrent execution guard
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType: 'cron',
    triggeredBy: null,
  });

  logger.info({ jobName: JOB_NAME }, 'Crude Price cron tick — fetching latest Brent spot price');
  try {
    const result = await fetchCrudeBrentIndicator({ triggerType: 'cron', triggeredBy: null });
    const summary = {
      indicatorCode: result.indicatorCode,
      status: result.status,
      observationDate: result.observationDate,
      value: result.value,
    };
    logger.info(summary, 'Crude Price cron tick complete');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: result.status === 'success' ? 'success' : 'failed',
      rowsInserted: result.rowsInserted,
      rowsUpdated: result.rowsUpdated,
      rowsSkipped: result.rowsSkipped,
      errors: result.errors ? (result.errors as unknown as object) : undefined,
      metadata: summary,
    });
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    logger.error({ ...errorPayload, jobName: JOB_NAME }, 'Crude Price cron tick crashed');
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });
  }
}

/**
 * Schedule daily Crude Price Brent fetch at 02:30 UTC (08:00 IST) — the same slot
 * as the EODHD price fetch. Lands well before the 14:30 UTC NIFTY scorecard
 * assembly. Manual triggers are exposed via /api/admin/jobs/run
 * (job_name 'crude_price_fetch').
 */
export function registerCrudePriceFetchCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '35 2 * * *', // 02:35 UTC daily
    runCrudeBrentFetch,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

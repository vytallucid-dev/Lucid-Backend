import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { fetchYahooBrentIndicator } from '@modules/nifty/services/yahoo-brent-indicator.service';
import { isJobRunning } from './job-guard';

const JOB_NAME = 'yahoo_brent_fetch';
const CONCURRENT_GUARD_MINUTES = 5;

/**
 * Daily Yahoo Finance fetch handler for NIFTY Brent (Ind 11), symbol BZ=F. Wraps
 * `fetchYahooBrentIndicator` with an orchestrator-level fetch_log entry
 * (`yahoo_brent_fetch`, separate from the per-indicator `fetch_yahoo_brent` row
 * the underlying service writes). The orchestrator row is what the
 * concurrent-execution guard checks.
 *
 * Brent moved off the Crude Price API (which froze at 89.18 for 10+ consecutive
 * days) to Yahoo Finance's BZ=F futures, verified fresh and moving before this
 * switch. DXY and USD/INR stay on EODHD.
 *
 * Called by BOTH the cron registration below and the manual /api/admin/jobs/run
 * trigger (job_name 'yahoo_brent_fetch') — one job function, two callers.
 */
export async function runYahooBrentFetch(): Promise<void> {
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

  logger.info({ jobName: JOB_NAME }, 'Yahoo Brent cron tick — fetching BZ=F daily history');
  try {
    const result = await fetchYahooBrentIndicator({ triggerType: 'cron', triggeredBy: null });
    const summary = {
      indicatorCode: result.indicatorCode,
      status: result.status,
      observationDate: result.observationDate,
      value: result.value,
      staleWarning: result.staleWarning,
    };
    logger.info(summary, 'Yahoo Brent cron tick complete');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: result.status,
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
    logger.error({ ...errorPayload, jobName: JOB_NAME }, 'Yahoo Brent cron tick crashed');
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });
  }
}

/**
 * Schedule daily Yahoo Brent fetch at 02:35 UTC (08:05 IST) — the same slot the
 * Crude Price Brent cron used. Lands well before the 14:30 UTC NIFTY scorecard
 * assembly. Manual triggers are exposed via /api/admin/jobs/run
 * (job_name 'yahoo_brent_fetch').
 */
export function registerYahooBrentFetchCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '35 2 * * *', // 02:35 UTC daily
    runYahooBrentFetch,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

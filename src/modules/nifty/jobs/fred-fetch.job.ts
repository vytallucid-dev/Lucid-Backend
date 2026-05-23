import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { fetchAllFredIndicators } from '@modules/nifty/services/fred-indicator.service';
import { isJobRunning } from './job-guard';

const JOB_NAME = 'fred_daily_fetch';
const CONCURRENT_GUARD_MINUTES = 5;

/**
 * Daily FRED fetch handler. Wraps `fetchAllFredIndicators` with an
 * orchestrator-level fetch_log entry (separate from the per-indicator
 * `fetch_fred_<code>` rows written by the underlying service). The
 * orchestrator row is what the concurrent-execution guard checks.
 */
export async function runFredFetchAll(): Promise<void> {
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

  logger.info({ jobName: JOB_NAME }, 'FRED cron tick — fetching all FRED indicators');
  try {
    const results = await fetchAllFredIndicators('cron', null);
    const summary = {
      totalIndicators: results.length,
      succeeded: results.filter((r) => r.status === 'success').length,
      partial: results.filter((r) => r.status === 'partial').length,
      failed: results.filter((r) => r.status === 'failed').length,
    };
    logger.info(summary, 'FRED cron tick complete');

    const overallStatus =
      summary.failed > 0 && summary.succeeded === 0
        ? 'failed'
        : summary.failed > 0 || summary.partial > 0
          ? 'partial'
          : 'success';

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: overallStatus,
      rowsInserted: summary.succeeded,
      rowsUpdated: summary.partial,
      rowsSkipped: summary.failed,
      metadata: summary,
    });
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    logger.error({ ...errorPayload, jobName: JOB_NAME }, 'FRED cron tick crashed');
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });
  }
}

/**
 * Schedule daily FRED fetch at 02:30 UTC (08:00 IST).
 * Manual triggers are exposed via /api/admin/jobs/run.
 */
export function registerFredFetchCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '30 2 * * *', // 02:30 UTC daily
    runFredFetchAll,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

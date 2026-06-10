import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { fetchAllEodhdIndicators } from '@modules/nifty/services/eodhd-indicator.service';
import { isJobRunning } from './job-guard';

const JOB_NAME = 'eodhd_fetch';
const CONCURRENT_GUARD_MINUTES = 5;

/**
 * Daily EODHD fetch handler for the two NIFTY price indicators (DXY, USD/INR).
 * Brent moved off EODHD to the Crude Price API (see crude-price-fetch.job.ts).
 * Wraps `fetchAllEodhdIndicators` with an orchestrator-level fetch_log entry
 * (separate from the per-indicator `fetch_eodhd_<code>` rows written by the
 * underlying service). The orchestrator row (`eodhd_fetch`) is what the
 * concurrent-execution guard checks. Two API calls per run — well under the cap.
 *
 * Called by BOTH the cron registration below and the manual /api/admin/jobs/run
 * trigger (job_name 'eodhd_fetch') — one job function, two callers.
 */
export async function runEodhdFetchAll(): Promise<void> {
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

  logger.info({ jobName: JOB_NAME }, 'EODHD cron tick — fetching all EODHD NIFTY indicators');
  try {
    const results = await fetchAllEodhdIndicators('cron', null);
    const summary = {
      totalIndicators: results.length,
      succeeded: results.filter((r) => r.status === 'success').length,
      partial: results.filter((r) => r.status === 'partial').length,
      failed: results.filter((r) => r.status === 'failed').length,
    };
    logger.info(summary, 'EODHD cron tick complete');

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
    logger.error({ ...errorPayload, jobName: JOB_NAME }, 'EODHD cron tick crashed');
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });
  }
}

/**
 * Schedule daily EODHD fetch at 02:30 UTC (08:00 IST) — the same slot the FRED
 * price fetch used. EODHD publishes EOD data overnight, and this lands well
 * before the 14:30 UTC NIFTY scorecard assembly.
 * Manual triggers are exposed via /api/admin/jobs/run (job_name 'eodhd_fetch').
 */
export function registerEodhdFetchCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '30 2 * * *', // 02:30 UTC daily
    runEodhdFetchAll,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

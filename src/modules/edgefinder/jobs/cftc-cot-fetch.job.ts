import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { fetchCftcCotData } from '@modules/edgefinder/services/cftc-cot-indicator.service';
import { isJobRunning } from '@modules/nifty/jobs/job-guard';

const JOB_NAME = 'cftc_cot_weekly_fetch';
const CONCURRENT_GUARD_MINUTES = 5;

/**
 * Weekly CFTC COT (Commitment of Traders) fetch. Pulls the most recent ~60
 * days of Legacy Futures-only rows for the 5 EdgeFinder-tracked contracts and
 * persists them into cot_data with vintage-aware upserts.
 */
export async function runCftcCotFetch(): Promise<void> {
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  logger.info({ jobName: JOB_NAME }, 'CFTC COT cron tick — fetching recent rows');
  try {
    const result = await fetchCftcCotData('cron', null);
    logger.info(
      {
        jobName: JOB_NAME,
        status: result.status,
        totalRowsFetched: result.totalRowsFetched,
        matchedAssetsCount: result.matchedAssetsCount,
        unmatchedRowsCount: result.unmatchedRowsCount,
        rowsInserted: result.rowsInserted,
        rowsUpdated: result.rowsUpdated,
        rowsSkipped: result.rowsSkipped,
        errorCount: result.errors.length,
      },
      'CFTC COT cron tick complete',
    );
  } catch (err) {
    logger.error(
      {
        jobName: JOB_NAME,
        message: err instanceof Error ? err.message : String(err),
      },
      'CFTC COT cron tick crashed',
    );
  }
}

/**
 * Schedule weekly CFTC COT fetch — Friday 22:00 UTC.
 * CFTC publishes the Legacy report ~19:30/20:30 UTC on Fridays; 22:00 UTC
 * buffers for late publication and DST shifts.
 */
export function registerCftcCotFetchCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '0 22 * * 5',
    runCftcCotFetch,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

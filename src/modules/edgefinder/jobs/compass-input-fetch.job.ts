import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { runAllCompassInputs } from '@modules/edgefinder/services/compass/compass-input-orchestrator.service';
import { isJobRunning } from '@modules/nifty/jobs/job-guard';

const JOB_NAME = 'compass_inputs_daily_fetch';
const CONCURRENT_GUARD_MINUTES = 10;

/**
 * Daily Compass-input fetch. Orchestrates ingestion of the 6 Lucid Compass
 * inputs (VIX, HY OAS, 2s10s, DXY trend, Gold/DXY correlation, US data stack).
 * Sequenced 22:30 UTC daily — after US market close (~21:00 UTC) and after
 * Yahoo + FRED have published end-of-day values.
 */
export async function runCompassInputFetch(): Promise<void> {
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  logger.info({ jobName: JOB_NAME }, 'Compass input cron tick — running all 6 inputs');
  try {
    const result = await runAllCompassInputs('cron', null);
    logger.info(
      {
        jobName: JOB_NAME,
        status: result.status,
        inputsSucceeded: result.inputsSucceeded,
        failedCount: result.inputsFailed.length,
        durationMs: result.durationMs,
      },
      'Compass input cron tick complete',
    );
  } catch (err) {
    logger.error(
      {
        jobName: JOB_NAME,
        message: err instanceof Error ? err.message : String(err),
      },
      'Compass input cron tick crashed',
    );
  }
}

/**
 * Schedule daily Compass input fetch at 22:30 UTC.
 */
export function registerCompassInputFetchCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '30 22 * * *',
    runCompassInputFetch,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

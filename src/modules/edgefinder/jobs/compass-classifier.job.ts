import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { runCompassClassifier } from '@modules/edgefinder/services/compass/compass-classifier.service';
import { isJobRunning } from '@modules/nifty/jobs/job-guard';

const JOB_NAME = 'compass_classifier_daily_run';
const CONCURRENT_GUARD_MINUTES = 10;

/**
 * Daily Compass regime classifier. Runs at 23:00 UTC — 30 minutes after the
 * 22:30 UTC compass_inputs cron so all 6 input rows are present for today.
 *
 * Reads compass_inputs for the day, classifies the regime, writes a row to
 * compass_classifications. Phase 7B = classifier only; Risk-Off override
 * application lives in Phase 7C.
 */
export async function runCompassClassifierJob(): Promise<void> {
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  logger.info({ jobName: JOB_NAME }, 'Compass classifier cron tick');
  try {
    const result = await runCompassClassifier('cron', null);
    logger.info(
      {
        jobName: JOB_NAME,
        status: result.status,
        candidateRegime: result.candidateRegime,
        activeRegime: result.activeRegime,
        persistenceDaysCount: result.persistenceDaysCount,
        crisisOverrideFired: result.crisisOverrideFired,
        action: result.action,
      },
      'Compass classifier cron tick complete',
    );
  } catch (err) {
    logger.error(
      {
        jobName: JOB_NAME,
        message: err instanceof Error ? err.message : String(err),
      },
      'Compass classifier cron tick crashed',
    );
  }
}

/**
 * Schedule daily Compass classifier at 23:00 UTC.
 */
export function registerCompassClassifierCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '0 23 * * *',
    runCompassClassifierJob,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

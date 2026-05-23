import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { runScorecardOrchestrator } from '@modules/edgefinder/services/scorecard/scorecard-orchestrator.service';
import { isJobRunning } from '@modules/nifty/jobs/job-guard';

const JOB_NAME = 'edgefinder_scorecard_assembly';
const CONCURRENT_GUARD_MINUTES = 15;

/**
 * Daily EdgeFinder asset scorecard assembly. Runs at 23:30 UTC — 30 minutes
 * after the Compass classifier (23:00 UTC) so today's regime is available.
 *
 * Scope: USD, EUR, GBP, JPY, XAUUSD. SPY/NAS100 are seeded with isActive=false
 * and skipped at the orchestrator layer; pair scoring (EURUSD etc.) is Phase 5.
 */
export async function runScorecardAssemblyJob(): Promise<void> {
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  logger.info({ jobName: JOB_NAME }, 'EdgeFinder scorecard assembly cron tick');
  try {
    const result = await runScorecardOrchestrator('cron', null);
    logger.info(
      {
        jobName: JOB_NAME,
        status: result.status,
        succeeded: result.assetsSucceeded,
        failedCount: result.assetsFailed.length,
        durationMs: result.durationMs,
      },
      'EdgeFinder scorecard assembly cron tick complete',
    );
  } catch (err) {
    logger.error(
      {
        jobName: JOB_NAME,
        message: err instanceof Error ? err.message : String(err),
      },
      'EdgeFinder scorecard assembly cron tick crashed',
    );
  }
}

/**
 * Schedule daily scorecard assembly at 23:30 UTC.
 */
export function registerScorecardAssemblyCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '30 23 * * *',
    runScorecardAssemblyJob,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

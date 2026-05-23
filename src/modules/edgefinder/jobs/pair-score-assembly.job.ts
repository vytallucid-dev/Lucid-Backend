import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { runPairScoreOrchestrator } from '@modules/edgefinder/services/pair-score/pair-score-orchestrator.service';
import { isJobRunning } from '@modules/nifty/jobs/job-guard';

const JOB_NAME = 'edgefinder_pair_score_assembly';
const CONCURRENT_GUARD_MINUTES = 15;

/**
 * Daily EdgeFinder pair score assembly. Runs at 23:45 UTC — 15 minutes after
 * the asset scorecard assembly (23:30 UTC) so the latest Compass regime and
 * any same-day scoring updates are available.
 *
 * Scope: EURUSD, GBPUSD, USDJPY, EURJPY, GBPJPY.
 */
export async function runPairScoreAssemblyJob(): Promise<void> {
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  logger.info({ jobName: JOB_NAME }, 'EdgeFinder pair score assembly cron tick');
  try {
    const result = await runPairScoreOrchestrator('cron', null);
    logger.info(
      {
        jobName: JOB_NAME,
        status: result.status,
        succeeded: result.pairsSucceeded,
        failedCount: result.pairsFailed.length,
        durationMs: result.durationMs,
      },
      'EdgeFinder pair score assembly cron tick complete',
    );
  } catch (err) {
    logger.error(
      {
        jobName: JOB_NAME,
        message: err instanceof Error ? err.message : String(err),
      },
      'EdgeFinder pair score assembly cron tick crashed',
    );
  }
}

/**
 * Schedule daily pair score assembly at 23:45 UTC.
 */
export function registerPairScoreAssemblyCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '45 23 * * *',
    runPairScoreAssemblyJob,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

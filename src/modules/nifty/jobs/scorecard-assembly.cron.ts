import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { assembleScorecard } from '@modules/nifty/services/scorecard-assembly.service';
import { isJobRunning } from './job-guard';
import { isTradingDay } from '@core/utils/trading-calendar';

const JOB_NAME = 'assemble_scorecard';
const CONCURRENT_GUARD_MINUTES = 5;

export async function runScorecardAssemblyCron(): Promise<void> {
  // Concurrent execution guard
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  // Use today's UTC date as observation date
  const now = new Date();
  const observationDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  // Non-trading days (weekend or NSE holiday, per nse_holidays) never get a
  // scorecard — added 2026-08-17. This covers both the cron trigger and the
  // admin "re-run assemble_scorecard" path, which calls this same function.
  if (!(await isTradingDay(observationDate))) {
    logger.info(
      { jobName: JOB_NAME, observationDate: observationDate.toISOString().slice(0, 10) },
      'Skipping scorecard assembly — not an NSE trading day',
    );
    return;
  }

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType: 'cron',
    triggeredBy: null,
    targetDateFrom: observationDate,
    targetDateTo: observationDate,
    metadata: {
      observationDate: observationDate.toISOString().slice(0, 10),
    },
  });

  try {
    const result = await assembleScorecard({
      observationDate,
      triggeredBy: null,
      triggerType: 'cron',
    });

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted: result.outcome === 'inserted' ? 1 : 0,
      rowsUpdated: result.outcome === 'revised' ? 1 : 0,
      rowsSkipped: result.outcome === 'skipped' ? 1 : 0,
    });

    logger.info(
      {
        jobName: JOB_NAME,
        outcome: result.outcome,
        netScore: result.netScore,
        band: result.band,
        observationDate: observationDate.toISOString().slice(0, 10),
      },
      'Scorecard assembly cron complete',
    );
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    logger.error({ ...errorPayload, jobName: JOB_NAME }, 'Scorecard assembly cron failed');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });
  }
}

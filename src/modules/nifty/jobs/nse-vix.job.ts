import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { scrapeNseVix } from '@modules/nifty/services/nse-vix.service';
import { isJobRunning } from './job-guard';

const JOB_NAME = 'scrape_nse_vix';
const CONCURRENT_GUARD_MINUTES = 5;

export async function runNseVixScrape(): Promise<void> {
  // Concurrent execution guard
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  logger.info({ jobName: JOB_NAME }, 'NSE VIX cron tick — scraping India VIX');
  try {
    const result = await scrapeNseVix({ triggerType: 'cron', triggeredBy: null });
    logger.info(
      {
        status: result.status,
        action: result.action,
        observationDate: result.observationDate,
        value: result.value,
      },
      'NSE VIX cron tick complete',
    );
  } catch (err) {
    logger.error({ err }, 'NSE VIX cron tick crashed');
  }
}

/**
 * Schedule daily India VIX scrape at 10:45 UTC (16:15 IST,
 * 45 min after NSE close).
 * Manual triggers are exposed via /api/admin/jobs/run.
 */
export function registerNseVixCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '45 10 * * *', // 10:45 UTC daily
    runNseVixScrape,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { scrapeNseFiiDii } from '@modules/nifty/services/nse-fii-dii.service';
import { isJobRunning } from './job-guard';

const JOB_NAME = 'scrape_nse_fii_dii';
const CONCURRENT_GUARD_MINUTES = 5;

export async function runNseFiiDiiScrape(): Promise<void> {
  // Concurrent execution guard
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  logger.info({ jobName: JOB_NAME }, '[NseFiiDiiCron] Tick — scraping FII/DII');
  try {
    const result = await scrapeNseFiiDii({
      triggerType: 'cron',
      triggeredBy: null,
    });
    logger.info({ result }, '[NseFiiDiiCron] Tick complete');
  } catch (err) {
    logger.error({ err }, '[NseFiiDiiCron] Tick crashed');
  }
}

/**
 * Schedule daily FII/DII fetch at 13:00 UTC (18:30 IST).
 * NSE typically publishes provisional FII/DII cash data by 18:00 IST.
 */
export function registerNseFiiDiiCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '0 13 * * *', // 13:00 UTC daily
    runNseFiiDiiScrape,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

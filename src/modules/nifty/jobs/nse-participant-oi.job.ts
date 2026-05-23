import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { scrapeNseParticipantOi } from '@modules/nifty/services/nse-participant-oi.service';
import { isJobRunning } from './job-guard';

const JOB_NAME = 'scrape_nse_participant_oi';
const CONCURRENT_GUARD_MINUTES = 5;

export async function runNseParticipantOiScrape(): Promise<void> {
  // Concurrent execution guard
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  logger.info({ jobName: JOB_NAME }, '[NseParticipantOiCron] Tick — fetching today FII L/S ratio');
  try {
    const result = await scrapeNseParticipantOi({
      triggerType: 'cron',
      triggeredBy: null,
    });
    logger.info({ result }, '[NseParticipantOiCron] Tick complete');
  } catch (err) {
    logger.error({ err }, '[NseParticipantOiCron] Tick crashed');
  }
}

/**
 * Schedule daily Participant-wise OI fetch at 14:00 UTC (19:30 IST).
 * NSE typically publishes the CSV by 19:00 IST.
 */
export function registerNseParticipantOiCron(): cron.ScheduledTask {
  const task = cron.schedule(
    '0 14 * * *', // 14:00 UTC daily
    runNseParticipantOiScrape,
    {
      scheduled: true,
      timezone: 'UTC',
      name: JOB_NAME,
    },
  );
  return task;
}

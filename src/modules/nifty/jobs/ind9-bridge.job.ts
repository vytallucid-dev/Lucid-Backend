import { logger } from '@core/utils/logger';
import { runInd9Bridge } from '@modules/nifty/services/ind9-bridge.service';
import { isJobRunning } from './job-guard';

const JOB_NAME = 'nifty_ind9_bridge';
const CONCURRENT_GUARD_MINUTES = 5;

export async function runNiftyInd9BridgeCron(): Promise<void> {
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  await runInd9Bridge('cron', null);
}

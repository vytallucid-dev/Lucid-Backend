import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { runScorecardAssemblyCron } from './scorecard-assembly.cron';
import { runNiftyInd9BridgeCron } from './ind9-bridge.job';
import { registerFredFetchCron } from './fred-fetch.job';
import { registerEodhdFetchCron } from './eodhd-fetch.job';
import { registerCrudePriceFetchCron } from './crude-price-fetch.job';
import { registerNseVixCron } from './nse-vix.job';
import { registerNseFiiDiiCron } from './nse-fii-dii.job';
import { registerNseParticipantOiCron } from './nse-participant-oi.job';

// Centralized startup-time cron registration. The existing FRED / NSE jobs
// each export a `register*Cron()` factory (they don't self-register on import)
// — those factories are invoked here. The new scorecard assembly cron is
// declared via the descriptor list below so the full daily schedule is
// discoverable in one place.

export interface CronJobDescriptor {
  name: string;
  schedule: string;
  timezone: string;
  handler: () => Promise<void>;
  description: string;
}

export const NIFTY_CRON_JOBS: CronJobDescriptor[] = [
  {
    name: 'assemble_scorecard',
    schedule: '30 14 * * *', // 14:30 UTC = 20:00 IST
    timezone: 'UTC',
    handler: runScorecardAssemblyCron,
    description: 'Daily NIFTY scorecard assembly (runs after all data fetches)',
  },
  {
    name: 'nifty_ind9_bridge',
    schedule: '50 23 * * *', // 23:50 UTC — after EdgeFinder pair score assembly at 23:45 UTC
    timezone: 'UTC',
    handler: runNiftyInd9BridgeCron,
    description: 'Daily NIFTY Ind 9 bridge — reads EdgeFinder USD scorecard, writes Ind 9 data_point',
  },
];

export function registerNiftyCrons(): void {
  // Invoke existing factory-style cron registrations (they configure their
  // own schedule/timezone/scheduled flags internally per file).
  registerFredFetchCron();
  // EODHD price fetch (DXY, USD/INR) — 02:30 UTC, same slot FRED used for these.
  // FRED cron stays for US02Y / EdgeFinder macro series; the two coexist.
  registerEodhdFetchCron();
  // Crude Price API fetch (Brent only) — 02:30 UTC, same slot as the EODHD price
  // fetch. Brent moved off EODHD's lagging FRED-routed commodity feed; runs daily
  // before the 14:30 UTC scorecard assembly.
  registerCrudePriceFetchCron();
  registerNseVixCron();
  registerNseFiiDiiCron();
  registerNseParticipantOiCron();

  // Descriptor-style crons declared in this file.
  for (const job of NIFTY_CRON_JOBS) {
    cron.schedule(job.schedule, job.handler, {
      scheduled: true,
      timezone: job.timezone,
      name: job.name,
    });
    logger.info(
      { jobName: job.name, schedule: job.schedule, timezone: job.timezone },
      'Registered NIFTY cron job',
    );
  }
}

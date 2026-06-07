import cron from 'node-cron';
import { logger } from '@core/utils/logger';
import { fetchForexFactoryWeek } from '@modules/edgefinder/services/forex-factory-indicator.service';
import { isJobRunning } from '@modules/nifty/jobs/job-guard';

const JOB_NAME = 'forex_factory_weekly_fetch';
const CONCURRENT_GUARD_MINUTES = 5;

/**
 * Daily Forex Factory weekly-calendar fetch. Pulls one week of FF events from
 * the public JSON feed and persists mapped events into EdgeFinder indicators.
 * The service writes its own data_fetch_log row, so this wrapper exists mostly
 * to provide a concurrent-execution guard and structured logging.
 */
export async function runForexFactoryFetch(): Promise<void> {
  const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
  if (alreadyRunning) {
    logger.warn({ jobName: JOB_NAME }, 'Skipping cron — another instance is running');
    return;
  }

  logger.info({ jobName: JOB_NAME }, 'ForexFactory cron tick — fetching weekly calendar');
  try {
    const result = await fetchForexFactoryWeek('cron', null);
    logger.info(
      {
        jobName: JOB_NAME,
        status: result.status,
        totalEvents: result.totalEvents,
        mappedCount: result.mappedCount,
        writtenWithActual: result.writtenWithActual,
        writtenForecastOnly: result.writtenForecastOnly,
        deferredCount: result.mappedDeferredCount,
        unmappedCount: result.unmappedCount,
        rowsInserted: result.rowsInserted,
        rowsUpdated: result.rowsUpdated,
        rowsSkipped: result.rowsSkipped,
        errorCount: result.errors.length,
      },
      'ForexFactory cron tick complete',
    );
  } catch (err) {
    logger.error(
      {
        jobName: JOB_NAME,
        message: err instanceof Error ? err.message : String(err),
      },
      'ForexFactory cron tick crashed',
    );
  }
}

// Twice-daily so same-day actuals land while the event is still in the CURRENT
// week's calendar (the old single 03:30 UTC run fired before US/EU/JP releases
// published, so events fell out of the current-week window before their actual
// was ever captured). Both runs hit the same 'week' endpoint and the same job
// function; the 5-min concurrent guard + shared JOB_NAME keep them coordinated.
const RUN_A_SCHEDULE = '30 15 * * *'; // 15:30 UTC (21:00 IST) — US afternoon + EU/UK morning releases
const RUN_B_SCHEDULE = '30 0 * * *'; //  00:30 UTC (06:00 IST) — JP overnight releases + revision safety net

/**
 * Schedule the two daily ForexFactory current-week fetches (15:30 + 00:30 UTC).
 * Manual triggers exposed via /api/admin/jobs/run.
 */
export function registerForexFactoryFetchCron(): cron.ScheduledTask[] {
  const runA = cron.schedule(RUN_A_SCHEDULE, runForexFactoryFetch, {
    scheduled: true,
    timezone: 'UTC',
    name: `${JOB_NAME}_1530`,
  });
  const runB = cron.schedule(RUN_B_SCHEDULE, runForexFactoryFetch, {
    scheduled: true,
    timezone: 'UTC',
    name: `${JOB_NAME}_0030`,
  });
  return [runA, runB];
}

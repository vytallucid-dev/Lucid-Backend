import { createApp } from './app';
import { env } from '@config/env';
import { logger } from '@core/utils/logger';
import { verifyDatabaseConnection, disconnectDatabase } from '@core/db/prisma';
// ── SCHEDULER ON HOLD — database recovery, 2026-09-14 ─────────────────────────
// The production scheduler kept writing into the database while it was being
// rebuilt, so every cron registration is commented out until recovery completes.
// RE-ENABLE BEFORE THE NEXT PRODUCTION PUSH: restore these imports and the
// registrations in bootstrap(), and restore `npx prisma migrate deploy && ` in
// package.json's start script. See docs/plans/DATABASE_RECOVERY_PLAN.md.
// import { registerNiftyCrons } from '@modules/nifty/jobs/cron-registry';
// import { registerForexFactoryFetchCron } from '@modules/edgefinder/jobs/forex-factory-fetch.job';
// import { registerCftcCotFetchCron } from '@modules/edgefinder/jobs/cftc-cot-fetch.job';
// import { registerCompassInputFetchCron } from '@modules/edgefinder/jobs/compass-input-fetch.job';
// import { registerCompassClassifierCron } from '@modules/edgefinder/jobs/compass-classifier.job';
// import { registerScorecardAssemblyCron } from '@modules/edgefinder/jobs/scorecard-assembly.job';
// import { registerPairScoreAssemblyCron } from '@modules/edgefinder/jobs/pair-score-assembly.job';

async function bootstrap(): Promise<void> {
  try {
    await verifyDatabaseConnection();

    const app = createApp();

    // SCHEDULER ON HOLD (database recovery) — see the note above the imports.
    // if (process.env.NODE_ENV !== 'test') {
    //   registerNiftyCrons();
    //   registerForexFactoryFetchCron();
    //   registerCftcCotFetchCron();
    //   registerCompassInputFetchCron();
    //   registerCompassClassifierCron();
    //   registerScorecardAssemblyCron();
    //   registerPairScoreAssemblyCron();
    // }
    logger.warn('Scheduler ON HOLD for database recovery — no cron jobs registered');

    const server = app.listen(env.PORT, () => {
      logger.info(`Lucid backend running on port ${env.PORT} (${env.NODE_ENV})`);

      if (env.NODE_ENV === 'development') {
        logger.info(`Local URL: http://localhost:${env.PORT}`);
      } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        logger.info(`Lucid production backend is live and listening on port ${env.PORT}`);
      }
    });

    const shutdown = async (signal: string): Promise<void> => {
      logger.info(`${signal} received, shutting down gracefully...`);
      server.close(async () => {
        await disconnectDatabase();
        process.exit(0);
      });
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

void bootstrap();

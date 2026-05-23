import { createApp } from './app';
import { env } from '@config/env';
import { logger } from '@core/utils/logger';
import { verifyDatabaseConnection, disconnectDatabase } from '@core/db/prisma';
import { registerNiftyCrons } from '@modules/nifty/jobs/cron-registry';
import { registerForexFactoryFetchCron } from '@modules/edgefinder/jobs/forex-factory-fetch.job';
import { registerCftcCotFetchCron } from '@modules/edgefinder/jobs/cftc-cot-fetch.job';
import { registerCompassInputFetchCron } from '@modules/edgefinder/jobs/compass-input-fetch.job';
import { registerCompassClassifierCron } from '@modules/edgefinder/jobs/compass-classifier.job';
import { registerScorecardAssemblyCron } from '@modules/edgefinder/jobs/scorecard-assembly.job';
import { registerPairScoreAssemblyCron } from '@modules/edgefinder/jobs/pair-score-assembly.job';

async function bootstrap(): Promise<void> {
  try {
    await verifyDatabaseConnection();

    const app = createApp();

    if (process.env.NODE_ENV !== 'test') {
      registerNiftyCrons();
      registerForexFactoryFetchCron();
      registerCftcCotFetchCron();
      registerCompassInputFetchCron();
      registerCompassClassifierCron();
      registerScorecardAssemblyCron();
      registerPairScoreAssemblyCron();
    }

    const server = app.listen(env.PORT, () => {
      logger.info(`Lucid backend running on port ${env.PORT} (${env.NODE_ENV})`);
      logger.info(`Local URL: http://localhost:${env.PORT}`);
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

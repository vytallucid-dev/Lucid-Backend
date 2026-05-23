import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from '@config/env';
import { logger } from '@core/utils/logger';
import { requestId } from '@core/middleware/request-id';
import { errorHandler, notFoundHandler } from '@core/middleware/error-handler';
import { requireAuth } from '@core/middleware/supabase-auth.middleware';
import { healthRouter } from '@core/routes/health.routes';
import { adminRouter } from '@core/routes/admin.routes';
import { userRouter } from '@core/routes/user.routes';
import { niftyRouter } from '@modules/nifty/routes';
import { niftyPublicRouter } from '@modules/nifty/routes/nifty-public.routes';
import { niftyPublicV2Router } from '@modules/nifty/api/nifty.routes';
import { edgefinderRouter } from '@modules/edgefinder/routes';
import { oracleRouter } from '@modules/edgefinder/api/oracle.routes';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.ALLOWED_ORIGINS,
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({ requestId: (req as { id?: string }).id }),
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },
    }),
  );

  app.use('/', healthRouter);
  app.use('/api/nifty', requireAuth, niftyRouter);
  app.use('/api/nifty', requireAuth, niftyPublicRouter);
  app.use('/api/nifty', requireAuth, niftyPublicV2Router);
  app.use('/api/oracle', requireAuth, oracleRouter);
  app.use('/api/edgefinder', edgefinderRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/user', userRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

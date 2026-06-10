import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { logger } from '@core/utils/logger';
import { runScorecardAssemblyCron } from '@modules/nifty/jobs/scorecard-assembly.cron';
import { runFredFetchAll } from '@modules/nifty/jobs/fred-fetch.job';
import { runEodhdFetchAll } from '@modules/nifty/jobs/eodhd-fetch.job';
import { runCrudeBrentFetch } from '@modules/nifty/jobs/crude-price-fetch.job';
import { runNseVixScrape } from '@modules/nifty/jobs/nse-vix.job';
import { runNseFiiDiiScrape } from '@modules/nifty/jobs/nse-fii-dii.job';
import { runNseParticipantOiScrape } from '@modules/nifty/jobs/nse-participant-oi.job';
import { runForexFactoryFetch } from '@modules/edgefinder/jobs/forex-factory-fetch.job';
import { runCftcCotFetch } from '@modules/edgefinder/jobs/cftc-cot-fetch.job';
import { runCompassInputFetch } from '@modules/edgefinder/jobs/compass-input-fetch.job';
import { runCompassClassifierJob } from '@modules/edgefinder/jobs/compass-classifier.job';
import { runScorecardAssemblyJob } from '@modules/edgefinder/jobs/scorecard-assembly.job';
import { runPairScoreAssemblyJob } from '@modules/edgefinder/jobs/pair-score-assembly.job';
import { runNiftyInd9BridgeCron } from '@modules/nifty/jobs/ind9-bridge.job';

export const cronTriggerRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

type JobHandler = () => Promise<void>;

const JOB_HANDLERS: Record<string, JobHandler> = {
  fred_fetch: runFredFetchAll,
  eodhd_fetch: runEodhdFetchAll,
  crude_price_fetch: runCrudeBrentFetch,
  nse_vix: runNseVixScrape,
  nse_fii_dii: runNseFiiDiiScrape,
  nse_participant_oi: runNseParticipantOiScrape,
  assemble_scorecard: runScorecardAssemblyCron,
  forex_factory_fetch: runForexFactoryFetch,
  cftc_cot_fetch: runCftcCotFetch,
  compass_inputs_fetch: runCompassInputFetch,
  compass_classifier_run: runCompassClassifierJob,
  scorecard_assembly: runScorecardAssemblyJob,
  pair_score_assembly: runPairScoreAssemblyJob,
  nifty_ind9_bridge: runNiftyInd9BridgeCron,
};

const triggerBodySchema = z.object({
  job_name: z.enum([
    'fred_fetch',
    'eodhd_fetch',
    'crude_price_fetch',
    'nse_vix',
    'nse_fii_dii',
    'nse_participant_oi',
    'assemble_scorecard',
    'forex_factory_fetch',
    'cftc_cot_fetch',
    'compass_inputs_fetch',
    'compass_classifier_run',
    'scorecard_assembly',
    'pair_score_assembly',
    'nifty_ind9_bridge',
  ]),
});

cronTriggerRouter.post(
  '/run',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = triggerBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid body', 'VALIDATION_ERROR', parsed.error.flatten());
      }

      const handler = JOB_HANDLERS[parsed.data.job_name];
      if (!handler) {
        throw new AppError(404, 'Unknown job', 'JOB_NOT_FOUND', { job: parsed.data.job_name });
      }

      logger.info(
        {
          jobName: parsed.data.job_name,
          triggeredBy: req.user?.email ?? 'unknown',
          userId: req.user?.sub,
        },
        'Manual cron trigger received',
      );

      // Fire-and-forget — return immediately, job logs to data_fetch_log
      // for status tracking via /api/admin/logs
      handler().catch((err) => {
        logger.error(
          {
            err: err instanceof Error ? err.message : String(err),
            jobName: parsed.data.job_name,
          },
          'Manual cron trigger failed',
        );
      });

      res.json({
        success: true,
        message: `Job ${parsed.data.job_name} triggered. Poll /api/admin/logs?job_name=${parsed.data.job_name} for status.`,
        job_name: parsed.data.job_name,
      });
    } catch (err) {
      next(err);
    }
  },
);

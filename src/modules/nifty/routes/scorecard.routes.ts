import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { assembleScorecard } from '@modules/nifty/services/scorecard-assembly.service';
import { isTradingDay } from '@core/utils/trading-calendar';
import { isJobRunning } from '@modules/nifty/jobs/job-guard';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';

export const scorecardRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const assembleBodySchema = z.object({
  observation_date: isoDate,
});

// Same job name the cron/admin-rerun path uses (scorecard-assembly.cron.ts),
// deliberately, so isJobRunning() sees overlap between this route and those
// — and so a manual assemble here also blocks a concurrent cron tick.
const JOB_NAME = 'assemble_scorecard';
const CONCURRENT_GUARD_MINUTES = 5;

scorecardRouter.post(
  '/assemble',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = assembleBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, 'Invalid body', 'VALIDATION_ERROR', parsed.error.flatten());
      }

      const triggeredBy = (req as { id?: string }).id ?? null;
      const observationDate = new Date(`${parsed.data.observation_date}T00:00:00.000Z`);

      // Added 2026-08-17 — this was previously the only scorecard-generation
      // path with neither a trading-day check nor a concurrency guard,
      // despite accepting an arbitrary caller-supplied date.
      if (!(await isTradingDay(observationDate))) {
        throw new AppError(
          400,
          `${parsed.data.observation_date} is not an NSE trading day (weekend or holiday)`,
          'NOT_A_TRADING_DAY',
        );
      }

      const alreadyRunning = await isJobRunning(JOB_NAME, CONCURRENT_GUARD_MINUTES);
      if (alreadyRunning) {
        throw new AppError(
          409,
          'Scorecard assembly is already running — try again shortly',
          'JOB_ALREADY_RUNNING',
        );
      }

      const log = await dataFetchLogRepository.start({
        jobName: JOB_NAME,
        triggerType: 'manual',
        triggeredBy,
        targetDateFrom: observationDate,
        targetDateTo: observationDate,
        metadata: { observationDate: parsed.data.observation_date },
      });

      try {
        const result = await assembleScorecard({
          observationDate,
          triggeredBy,
          triggerType: 'manual',
        });

        await dataFetchLogRepository.complete({
          logId: log.id,
          status: 'success',
          rowsInserted: result.outcome === 'inserted' ? 1 : 0,
          rowsUpdated: result.outcome === 'revised' ? 1 : 0,
          rowsSkipped: result.outcome === 'skipped' ? 1 : 0,
        });

        res.json({ success: true, result });
      } catch (err) {
        const errorPayload = {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        };
        await dataFetchLogRepository.complete({
          logId: log.id,
          status: 'failed',
          errors: [errorPayload] as unknown as object,
        });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

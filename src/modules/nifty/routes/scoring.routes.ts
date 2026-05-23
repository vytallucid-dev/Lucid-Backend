import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import {
  computeAndStoreScore,
  computeAllScoresForDate,
} from '@core/scoring/score-writer.service';

export const scoringRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const computeOneBodySchema = z.object({
  observation_date: isoDate,
});

scoringRouter.post(
  '/compute/:indicatorCode',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = computeOneBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, 'Invalid body', 'VALIDATION_ERROR', parsed.error.flatten());
      }
      const indicatorCode = req.params.indicatorCode as string;
      if (!indicatorCode) {
        throw new AppError(400, 'Missing indicatorCode param', 'VALIDATION_ERROR');
      }
      const observationDate = new Date(`${parsed.data.observation_date}T00:00:00.000Z`);
      const result = await computeAndStoreScore({ indicatorCode, observationDate });
      res.json({ success: result.outcome !== 'insufficient_data', result });
    } catch (err) {
      next(err);
    }
  },
);

const computeAllBodySchema = z.object({
  observation_date: isoDate,
});

scoringRouter.post(
  '/compute-all',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = computeAllBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, 'Invalid body', 'VALIDATION_ERROR', parsed.error.flatten());
      }
      const observationDate = new Date(`${parsed.data.observation_date}T00:00:00.000Z`);
      const results = await computeAllScoresForDate(observationDate);
      const summary = {
        total: results.length,
        scored: results.filter((r) => r.outcome === 'scored').length,
        carryForward: results.filter((r) => r.outcome === 'carry_forward').length,
        insufficientData: results.filter((r) => r.outcome === 'insufficient_data').length,
      };
      res.json({
        success: true,
        observationDate: parsed.data.observation_date,
        summary,
        results,
      });
    } catch (err) {
      next(err);
    }
  },
);

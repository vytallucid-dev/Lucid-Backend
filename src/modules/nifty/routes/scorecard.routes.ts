import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { assembleScorecard } from '@modules/nifty/services/scorecard-assembly.service';

export const scorecardRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const assembleBodySchema = z.object({
  observation_date: isoDate,
});

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

      const result = await assembleScorecard({
        observationDate,
        triggeredBy,
        triggerType: 'manual',
      });

      res.json({ success: true, result });
    } catch (err) {
      next(err);
    }
  },
);

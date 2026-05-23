import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { fetchFredIndicator, fetchAllFredIndicators } from '@modules/nifty/services/fred-indicator.service';

export const fredRouter = Router();

const fetchOneSchema = z.object({
  indicator_code: z.string().min(1),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const fetchAllSchema = z.object({
  // no body required
}).strict();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

fredRouter.post('/fetch-fred-indicator/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = fetchOneSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const triggeredBy = (req as { id?: string }).id ?? null;

    const result = await fetchFredIndicator({
      indicatorCode: parsed.data.indicator_code,
      dateFrom: parsed.data.date_from ? new Date(`${parsed.data.date_from}T00:00:00.000Z`) : undefined,
      dateTo: parsed.data.date_to ? new Date(`${parsed.data.date_to}T00:00:00.000Z`) : undefined,
      triggerType: 'manual',
      triggeredBy,
    });

    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
});

fredRouter.post('/fetch-all-fred-indicators/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = fetchAllSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const triggeredBy = (req as { id?: string }).id ?? null;
    const results = await fetchAllFredIndicators('manual', triggeredBy);

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.status === 'success').length,
      partial: results.filter((r) => r.status === 'partial').length,
      failed: results.filter((r) => r.status === 'failed').length,
    };

    res.json({ success: true, summary, results });
  } catch (err) {
    next(err);
  }
});

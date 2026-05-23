import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { submitManualInput } from '@modules/nifty/services/manual-input.service';
import { getDataGapsReport } from '@modules/nifty/services/data-gaps.service';

export const manualInputRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

const manualInputSchema = z.object({
  indicator_code: z.string().min(1),
  observation_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  value: z.number().finite(),
  notes: z.string().max(1000).optional(),
  allow_overwrite: z.boolean().optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
});

manualInputRouter.post('/manual-input', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = manualInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const triggeredBy = req.user?.email ?? (req as { id?: string }).id ?? null;

    const result = await submitManualInput({
      indicatorCode: parsed.data.indicator_code,
      observationDate: new Date(`${parsed.data.observation_date}T00:00:00.000Z`),
      value: parsed.data.value,
      notes: parsed.data.notes ?? null,
      allowOverwrite: parsed.data.allow_overwrite ?? false,
      triggeredBy,
      sourceMetadata: parsed.data.source_metadata,
    });

    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
});

const gapsQuerySchema = z.object({
  as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

manualInputRouter.get('/data-gaps', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = gapsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const asOf = parsed.data.as_of ? new Date(`${parsed.data.as_of}T00:00:00.000Z`) : new Date();

    const report = await getDataGapsReport(asOf);

    const summary = {
      total: report.length,
      fresh: report.filter((r) => r.severity === 'fresh').length,
      warning: report.filter((r) => r.severity === 'warning').length,
      critical: report.filter((r) => r.severity === 'critical').length,
      never: report.filter((r) => r.severity === 'never').length,
    };

    res.json({ success: true, asOf: asOf.toISOString().slice(0, 10), summary, indicators: report });
  } catch (err) {
    next(err);
  }
});

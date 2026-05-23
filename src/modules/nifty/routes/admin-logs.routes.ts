import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { getAdminLogs } from '@modules/nifty/services/public-api.service';

export const adminLogsRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const logsQuerySchema = z
  .object({
    job_name: z.string().max(200).optional(),
    status: z.enum(['success', 'partial', 'failed']).optional(),
    trigger_type: z.enum(['cron', 'manual', 'backfill']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((s) => parseInt(s, 10))
      .optional(),
    offset: z
      .string()
      .regex(/^\d+$/)
      .transform((s) => parseInt(s, 10))
      .optional(),
  })
  .strict();

adminLogsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = logsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const result = await getAdminLogs({
      jobName: parsed.data.job_name,
      status: parsed.data.status,
      triggerType: parsed.data.trigger_type,
      from: parsed.data.from ? new Date(`${parsed.data.from}T00:00:00.000Z`) : undefined,
      to: parsed.data.to ? new Date(`${parsed.data.to}T23:59:59.999Z`) : undefined,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

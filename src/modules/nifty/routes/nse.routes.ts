import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { scrapeNseVix } from '@modules/nifty/services/nse-vix.service';
import { scrapeNseFiiDii } from '@modules/nifty/services/nse-fii-dii.service';
import { scrapeNseParticipantOi } from '@modules/nifty/services/nse-participant-oi.service';

export const nseRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

const emptyBodySchema = z.object({}).strict();

nseRouter.post(
  '/scrape-nse-vix/run',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = emptyBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten());
      }
      const triggeredBy = (req as { id?: string }).id ?? null;
      const result = await scrapeNseVix({
        triggerType: 'manual',
        triggeredBy,
      });
      res.json({ success: result.status === 'success', result });
    } catch (err) {
      next(err);
    }
  },
);

nseRouter.post(
  '/scrape-nse-fii-dii/run',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = emptyBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten());
      }
      const triggeredBy = (req as { id?: string }).id ?? null;
      const result = await scrapeNseFiiDii({
        triggerType: 'manual',
        triggeredBy,
      });
      res.json({ success: result.status === 'success', result });
    } catch (err) {
      next(err);
    }
  },
);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

// Three modes: empty body = today; observation_date = single; date_from+date_to = range.
// Mutually exclusive: cannot mix observation_date with date_from/date_to.
const participantOiSchema = z
  .object({
    observation_date: isoDate.optional(),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
  })
  .strict()
  .refine(
    (data) => {
      const hasSingle = !!data.observation_date;
      const hasRange = !!data.date_from || !!data.date_to;
      if (hasSingle && hasRange) return false;
      if (hasRange && (!data.date_from || !data.date_to)) return false;
      return true;
    },
    {
      message:
        'Invalid combination. Provide either observation_date OR (date_from AND date_to), or neither (defaults to today).',
    },
  );

nseRouter.post(
  '/scrape-nse-participant-oi/run',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = participantOiSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten());
      }

      const triggeredBy = (req as { id?: string }).id ?? null;
      const data = parsed.data;

      const observationDate = data.observation_date
        ? new Date(`${data.observation_date}T00:00:00.000Z`)
        : undefined;
      const dateFrom = data.date_from
        ? new Date(`${data.date_from}T00:00:00.000Z`)
        : undefined;
      const dateTo = data.date_to ? new Date(`${data.date_to}T00:00:00.000Z`) : undefined;

      const triggerType: 'manual' | 'backfill' = dateFrom && dateTo ? 'backfill' : 'manual';

      const result = await scrapeNseParticipantOi({
        triggerType,
        triggeredBy,
        observationDate,
        dateFrom,
        dateTo,
      });

      res.json({ success: result.status === 'success', result });
    } catch (err) {
      next(err);
    }
  },
);

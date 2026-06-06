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

// Two modes: empty body = today; observation_date = single date.
const participantOiSchema = z
  .object({
    observation_date: isoDate.optional(),
  })
  .strict();

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

      const result = await scrapeNseParticipantOi({
        triggerType: 'manual',
        triggeredBy,
        observationDate,
      });

      res.json({ success: result.status === 'success', result });
    } catch (err) {
      next(err);
    }
  },
);

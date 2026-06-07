import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import {
  getLatestScorecard,
  getScorecardByDate,
  getScorecardHistory,
  getIndicators,
  getIndicatorDetail,
} from '@modules/nifty/services/public-api.service';
import {
  getVelocity,
  getVBottomCheck,
} from '@modules/nifty/services/sub-tools.service';

export const niftyPublicRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

niftyPublicRouter.get(
  '/scorecard/latest',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await getLatestScorecard();
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);

const historyQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((s) => parseInt(s, 10))
      .optional(),
    include_breakdown: z
      .string()
      .transform((s) => s === 'true' || s === '1')
      .optional(),
  })
  .strict();

niftyPublicRouter.get(
  '/scorecard/history',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = historyQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
      }

      const result = await getScorecardHistory({
        from: parsed.data.from ? new Date(`${parsed.data.from}T00:00:00.000Z`) : undefined,
        to: parsed.data.to ? new Date(`${parsed.data.to}T00:00:00.000Z`) : undefined,
        limit: parsed.data.limit,
        includeBreakdown: parsed.data.include_breakdown ?? false,
      });

      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  },
);

// :date is YYYY-MM-DD; placed AFTER /history so /history doesn't match :date
niftyPublicRouter.get(
  '/scorecard/:date',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dateStr = req.params.date;
      if (!isoDate.safeParse(dateStr).success) {
        throw new AppError(400, 'Invalid date format', 'VALIDATION_ERROR', { date: dateStr });
      }
      // "Today" is IST (India-markets tool): when it's already the current date
      // in IST (UTC+5:30) but not yet in UTC, that date is still valid. Compare
      // calendar-date strings against the IST date. Matches the IST offset
      // convention used elsewhere (nse-participant-oi.service).
      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const istToday = new Date(Date.now() + istOffsetMs).toISOString().slice(0, 10);
      if (dateStr > istToday) {
        throw new AppError(400, 'Date cannot be in the future', 'VALIDATION_ERROR');
      }
      // Scorecards key observation_date at UTC midnight (the assemble endpoint
      // stores it the same way), so a valid-but-unassembled date falls through to
      // a clean 404 SCORECARD_NOT_FOUND from getScorecardByDate.
      const observationDate = new Date(`${dateStr}T00:00:00.000Z`);
      const data = await getScorecardByDate(observationDate);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);

niftyPublicRouter.get(
  '/indicators',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await getIndicators();
      res.json({ success: true, count: items.length, items });
    } catch (err) {
      next(err);
    }
  },
);

const indicatorDetailQuerySchema = z
  .object({
    include_history: z
      .string()
      .transform((s) => s === 'true' || s === '1')
      .optional(),
  })
  .strict();

niftyPublicRouter.get(
  '/indicators/:code',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.params.code as string;
      const parsed = indicatorDetailQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
      }
      const data = await getIndicatorDetail({
        code,
        includeHistory: parsed.data.include_history ?? false,
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);

const velocityQuerySchema = z
  .object({
    start_date: isoDate.optional(),
    end_date: isoDate.optional(),
  })
  .strict();

niftyPublicRouter.get(
  '/velocity',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = velocityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
      }

      const startDate = parsed.data.start_date
        ? new Date(`${parsed.data.start_date}T00:00:00.000Z`)
        : undefined;
      const endDate = parsed.data.end_date
        ? new Date(`${parsed.data.end_date}T00:00:00.000Z`)
        : undefined;

      const result = await getVelocity({ startDate, endDate });

      res.json({
        success: true,
        data: {
          velocity: result.velocity.velocity,
          label: result.velocity.label,
          sessions: result.velocity.sessions,
          start_date: result.velocity.startDate,
          end_date: result.velocity.endDate,
          start_net: result.velocity.startNet,
          end_net: result.velocity.endNet,
          reason: result.velocity.reason ?? null,
          auto_anchors: {
            high_anchor_date: result.autoAnchors.highAnchorDate,
            high_anchor_net: result.autoAnchors.highAnchorNet,
            low_anchor_date: result.autoAnchors.lowAnchorDate,
            low_anchor_net: result.autoAnchors.lowAnchorNet,
            default_start_date: result.autoAnchors.defaultStartDate,
            default_start_net: result.autoAnchors.defaultStartNet,
          },
          trajectory: result.trajectory,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

const vBottomQuerySchema = z
  .object({
    date: isoDate.optional(),
  })
  .strict();

niftyPublicRouter.get(
  '/v-bottom-check',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = vBottomQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
      }

      const date = parsed.data.date
        ? new Date(`${parsed.data.date}T00:00:00.000Z`)
        : undefined;

      const result = await getVBottomCheck({ date });

      res.json({
        success: true,
        data: {
          date: result.date,
          ind9_raw: result.ind9Raw,
          classification: result.classification,
          forward_expectation: result.forwardExpectation,
          examples: result.examples.map((e) => ({
            date: e.date,
            description: e.description,
            raw_at_trough: e.rawAtTrough,
            outcome: e.outcome,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

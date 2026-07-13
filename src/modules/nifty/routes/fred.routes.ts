import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { prisma } from '@core/db/prisma';
import { fetchFredIndicator, fetchAllFredIndicators } from '@modules/nifty/services/fred-indicator.service';
import { fetchEodhdIndicator } from '@modules/nifty/services/eodhd-indicator.service';
import { fetchYahooBrentIndicator } from '@modules/nifty/services/yahoo-brent-indicator.service';

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

// NOTE: despite the FRED-specific path (kept so the existing frontend button
// works without a frontend change), this endpoint is SOURCE-AWARE. The NIFTY
// indicator-detail "Fetch" button posts here for every price indicator; DXY and
// USD/INR are EODHD-sourced and Brent is Yahoo-sourced (BZ=F), so each is
// routed to its service while everything else stays on FRED. All paths write to
// the same data_points table and data_fetch_log with triggerType 'manual'.
fredRouter.post('/fetch-fred-indicator/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = fetchOneSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const indicatorCode = parsed.data.indicator_code;
    const dateFrom = parsed.data.date_from
      ? new Date(`${parsed.data.date_from}T00:00:00.000Z`)
      : undefined;
    const dateTo = parsed.data.date_to
      ? new Date(`${parsed.data.date_to}T00:00:00.000Z`)
      : undefined;
    const triggeredBy = (req as { id?: string }).id ?? null;

    // Dispatch by the indicator's data source. If the code is unknown the lookup
    // returns null and we fall through to the FRED service, which throws the
    // canonical 404 INDICATOR_NOT_FOUND (preserving prior behavior).
    const indicator = await prisma.indicator.findUnique({
      where: { code: indicatorCode },
      select: { dataSource: true },
    });

    // Yahoo (Brent) takes no date range — the service always fetches the last
    // BRENT_FETCH_DAYS_BACK days and writes only the most recent trading day, so
    // date_from/date_to are intentionally not forwarded.
    const result =
      indicator?.dataSource === 'yahoo'
        ? await fetchYahooBrentIndicator({
            triggerType: 'manual',
            triggeredBy,
          })
        : indicator?.dataSource === 'eodhd'
          ? await fetchEodhdIndicator({
              indicatorCode,
              dateFrom,
              dateTo,
              triggerType: 'manual',
              triggeredBy,
            })
          : await fetchFredIndicator({
              indicatorCode,
              dateFrom,
              dateTo,
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

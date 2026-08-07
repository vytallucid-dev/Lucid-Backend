import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { getCalendarWindow } from '@modules/edgefinder/services/calendar.service';

export const calendarRouter = Router();

// Auth is enforced upstream at the /api/oracle mount (requireAuth).

const windowQuerySchema = z.object({
  // UTC instant bounds. The client owns the timezone question — it decides
  // what "today" means in the viewer's selected zone and sends the resulting
  // absolute instants. The server never guesses a display timezone.
  fromUtc: z.string().datetime({ offset: true }),
  toUtc: z.string().datetime({ offset: true }),
});

/**
 * GET /api/oracle/calendar?fromUtc=...&toUtc=...
 *
 * In-universe calendar events in a UTC instant window. The universe is
 * derived from the indicator registry (tool=edgefinder, dataSource=
 * forex_factory) — see calendar.service.ts. Out-of-universe events are stored
 * but never returned here; the admin unmapped queue is a separate endpoint.
 */
calendarRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = windowQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(
        400,
        'fromUtc and toUtc are required ISO-8601 instants with an offset',
        'CALENDAR_BAD_WINDOW',
        { issues: parsed.error.issues },
      );
    }

    const fromUtc = new Date(parsed.data.fromUtc);
    const toUtc = new Date(parsed.data.toUtc);

    if (toUtc <= fromUtc) {
      throw new AppError(400, 'toUtc must be after fromUtc', 'CALENDAR_BAD_WINDOW');
    }
    // Bounded so a malformed or hostile range can't ask for the whole table.
    const MAX_WINDOW_DAYS = 31;
    if (toUtc.getTime() - fromUtc.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
      throw new AppError(
        400,
        `Window must not exceed ${MAX_WINDOW_DAYS} days`,
        'CALENDAR_WINDOW_TOO_LARGE',
      );
    }

    const result = await getCalendarWindow({ fromUtc, toUtc });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

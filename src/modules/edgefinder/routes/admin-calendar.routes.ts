import { Router, Request, Response, NextFunction } from 'express';
import { getUnmappedQueue } from '@modules/edgefinder/services/calendar.service';

export const adminCalendarRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

/**
 * GET /api/admin/calendar/unmapped
 *
 * Calendar occurrences whose (country, title) matched no entry in
 * FF_EVENT_TO_INDICATOR, grouped by (country, title).
 *
 * This queue is the reason unmapped events are stored at all: when Forex
 * Factory renames a release, the indicator does not silently stop updating —
 * the new title appears here as a queue entry. A permanently empty queue
 * would mean the pipeline had gone blind to upstream drift.
 *
 * Note that a populated queue is NORMAL, not an alarm. The feed carries ~85
 * events a week that no EdgeFinder indicator tracks (NZD/CHF/CAD prints, bond
 * auctions, Fed speakers), plus the euro-area national sub-PMIs which are
 * excluded deliberately and permanently — see the header note in
 * forex-factory-event-mapping.ts. What matters is a title appearing here that
 * LOOKS like something already tracked.
 */
adminCalendarRouter.get('/unmapped', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sinceParam = typeof req.query.since === 'string' ? req.query.since : null;
    const since = sinceParam ? new Date(sinceParam) : undefined;

    const entries = await getUnmappedQueue({
      since: since && !Number.isNaN(since.getTime()) ? since : undefined,
    });

    res.json({ entries, count: entries.length });
  } catch (err) {
    next(err);
  }
});

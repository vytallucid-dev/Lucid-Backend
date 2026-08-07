import { Router, Request, Response, NextFunction } from 'express';
import { buildOverduePanel } from '@modules/edgefinder/services/overdue-panel.service';

export const overdueRouter = Router();

// Auth is enforced upstream at the /api/oracle/overdue mount (requireAuth) —
// see app.ts. Deliberately NOT admin-gated: the badge is "present on every page"
// per B3, which means every signed-in user, not just admins. Only the defer
// ACTIONS (admin-overdue.routes.ts) require the admin role, matching how
// manual data entry itself is admin-gated — seeing that a release is
// overdue is a read anyone benefits from; snoozing it is a curation action.

/**
 * GET /api/oracle/overdue
 *
 * The B3 top-bar badge/panel data: due-today, overdue, and deferred events,
 * plus the badge count (overdue only — see buildOverduePanel's doc for why
 * aging/DataHealth/deferred/due-today are all excluded from it).
 */
overdueRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const panel = await buildOverduePanel();
    res.json({ success: true, data: panel });
  } catch (err) {
    next(err);
  }
});

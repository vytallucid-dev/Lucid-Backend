import { Router } from 'express';
import { requireAuth, requireRole } from '@core/middleware/supabase-auth.middleware';
import { fredRouter } from '@modules/nifty/routes/fred.routes';
import { manualInputRouter } from '@modules/nifty/routes/manual-input.routes';
import { nseRouter } from '@modules/nifty/routes/nse.routes';
import { scoringRouter } from '@modules/nifty/routes/scoring.routes';
import { scorecardRouter } from '@modules/nifty/routes/scorecard.routes';
import { adminLogsRouter } from '@modules/nifty/routes/admin-logs.routes';
import { cronTriggerRouter } from '@modules/nifty/routes/cron-trigger.routes';
import { adminDataRouter } from '@modules/edgefinder/routes/admin-data.routes';
import { cycleStancesRouter } from '@modules/edgefinder/routes/cycle-stances.routes';
import { adminIndicatorsRouter } from '@modules/edgefinder/api/admin-indicators.routes';
import { adminValidationRouter } from '@modules/edgefinder/api/admin-validation.routes';

export const adminRouter = Router();

// Every admin route requires a verified JWT AND admin role.
adminRouter.use(requireAuth, requireRole('admin'));

adminRouter.get('/ping', (_req, res) => {
  res.json({ message: 'Admin route reachable. Auth working.' });
});

adminRouter.use('/jobs', fredRouter);
adminRouter.use('/jobs', nseRouter);
adminRouter.use('/jobs', cronTriggerRouter);
adminRouter.use('/data', manualInputRouter);
adminRouter.use('/data', adminDataRouter);
adminRouter.use('/cycle-stances', cycleStancesRouter);
adminRouter.use('/indicators', adminIndicatorsRouter);
adminRouter.use('/scoring', scoringRouter);
adminRouter.use('/scorecard', scorecardRouter);
adminRouter.use('/logs', adminLogsRouter);
adminRouter.use('/compass/validation', adminValidationRouter);

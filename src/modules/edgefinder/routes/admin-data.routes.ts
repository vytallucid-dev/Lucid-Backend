import { Router } from 'express';
import { manualDataEntryHandler } from '@modules/edgefinder/handlers/manual-data-entry.handler';

export const adminDataRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

adminDataRouter.post('/manual', manualDataEntryHandler);

import { Router } from 'express';
import { manualDataEntryHandler } from '@modules/edgefinder/handlers/manual-data-entry.handler';
import { manualDataEditHandler } from '@modules/edgefinder/handlers/manual-data-edit.handler';

export const adminDataRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

adminDataRouter.post('/manual', manualDataEntryHandler);

// B4 edit path — correcting an already-entered value in place. Separate from
// POST /manual (which logs a NEW release and infers revision-vs-typo from a
// previous-value mismatch): this route never creates a revision record, it
// overwrites the named row directly. See manual-data-edit.service.ts.
adminDataRouter.patch('/manual/:dataPointId', manualDataEditHandler);

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { calendarEventDeferralsRepository } from '@core/repositories/calendar-event-deferrals.repository';

export const adminOverdueRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).
// Reading overdue state is public (see overdue.routes.ts, mounted under
// /api/oracle); only these MUTATIONS — creating or removing a deferral — are
// admin-gated, matching manual data entry's own auth level.

const deferBodySchema = z
  .object({
    // Non-null: defer exactly this occurrence. Absent/null: standing
    // deferral — B2's "also apply to future releases of the same indicator".
    calendarEventId: z.string().uuid().nullable().optional(),
    // Required when calendarEventId is absent — a standing deferral has no
    // event row to derive the indicator/variant from.
    indicatorCode: z.string().min(1).max(50).optional(),
    variant: z.string().min(1).max(20).nullable().optional(),
    // Null/absent = deferred indefinitely. A date string = deferred to that
    // date (ISO YYYY-MM-DD; the resolver compares whole UTC calendar days,
    // see deferralHasExpired in overdue-resolver.ts).
    deferUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO date YYYY-MM-DD').nullable().optional(),
    // Prompted but optional at entry (B2) — never required.
    reason: z.string().max(280).nullable().optional(),
  })
  .refine((b) => b.calendarEventId || b.indicatorCode, {
    message: 'Either calendarEventId (one-off) or indicatorCode (standing) is required',
  });

/**
 * POST /api/admin/overdue/defer
 *
 * Create or replace a deferral. One-off (tied to calendarEventId) or
 * standing (indicatorCode + optional variant, calendarEventId omitted) —
 * see the CalendarEventDeferral model doc for the two shapes. A standing
 * deferral for a pair that already has one REPLACES it (new date/reason)
 * rather than stacking — see calendarEventDeferralsRepository.create.
 */
adminOverdueRouter.post('/defer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = deferBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid body', 'INVALID_BODY', { details: parsed.error.format() });
    }
    const body = parsed.data;

    let indicatorId: string;
    let indicatorCode: string;
    let variant: string | null;

    if (body.calendarEventId) {
      const event = await prisma.calendarEvent.findUnique({ where: { id: body.calendarEventId } });
      if (!event || !event.indicatorId || !event.indicatorCode) {
        throw new AppError(404, 'Calendar event not found or unmapped', 'CALENDAR_EVENT_NOT_FOUND', {
          calendarEventId: body.calendarEventId,
        });
      }
      indicatorId = event.indicatorId;
      indicatorCode = event.indicatorCode;
      variant = event.variant;
    } else {
      const indicator = await prisma.indicator.findUnique({ where: { code: body.indicatorCode as string } });
      if (!indicator) {
        throw new AppError(404, `Indicator ${body.indicatorCode} not found`, 'INDICATOR_NOT_FOUND');
      }
      indicatorId = indicator.id;
      indicatorCode = indicator.code;
      variant = body.variant ?? null;
    }

    const deferUntil = body.deferUntil ? new Date(`${body.deferUntil}T00:00:00.000Z`) : null;
    if (deferUntil && Number.isNaN(deferUntil.getTime())) {
      throw new AppError(400, 'Cannot parse deferUntil', 'DEFER_UNTIL_INVALID', { deferUntil: body.deferUntil });
    }

    const createdBy = req.user?.email ?? null;

    const deferral = await calendarEventDeferralsRepository.create({
      indicatorId,
      indicatorCode,
      variant,
      calendarEventId: body.calendarEventId ?? null,
      deferUntil,
      reason: body.reason ?? null,
      createdBy,
    });

    res.json({ success: true, data: deferral });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/overdue/defer/:id
 *
 * Remove a deferral — un-snoozes it, returning the event to overdue on the
 * next read (assuming it is still genuinely overdue; if data has since been
 * entered, removing the deferral is a no-op from the trader's perspective,
 * since the event is no longer overdue regardless).
 */
adminOverdueRouter.delete('/defer/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string | undefined;
    if (!id) {
      throw new AppError(400, 'Missing deferral id', 'INVALID_BODY');
    }
    await calendarEventDeferralsRepository.delete(id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

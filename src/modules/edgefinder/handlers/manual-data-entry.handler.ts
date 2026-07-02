import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import {
  ingestManualEntry,
  isRevisionMismatch,
} from '@modules/edgefinder/services/manual-data-entry.service';

export const ManualDataEntrySchema = z.object({
  indicatorCode: z.string().min(1).max(50),
  observationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO date YYYY-MM-DD'),
  actual: z.number().finite(),
  forecast: z.number().finite().nullable().optional(),
  previous: z.number().finite().nullable().optional(),
  notes: z.string().max(500).optional(),
  // Additive: when omitted the POST behaves exactly as before. Set true to
  // acknowledge a detected previous↔stored-actual mismatch and write anyway.
  confirmRevision: z.boolean().optional(),
});

export async function manualDataEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = ManualDataEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid body', 'INVALID_BODY', {
        details: parsed.error.format(),
      });
    }

    const { indicatorCode, observationDate, actual, forecast, previous, notes, confirmRevision } =
      parsed.data;

    const obsDate = new Date(`${observationDate}T00:00:00.000Z`);
    if (Number.isNaN(obsDate.getTime())) {
      throw new AppError(
        400,
        'Cannot parse observation date',
        'OBSERVATION_DATE_INVALID',
        { observationDate },
      );
    }
    const todayEnd = new Date();
    todayEnd.setUTCHours(23, 59, 59, 999);
    if (obsDate > todayEnd) {
      throw new AppError(
        400,
        'Observation date cannot be in the future',
        'OBSERVATION_DATE_INVALID',
        { observationDate },
      );
    }

    // Prefer authenticated user for audit; fall back to legacy x-admin-user header for now.
    const triggeredByHeader = req.headers['x-admin-user'];
    const triggeredBy =
      req.user?.email ?? (typeof triggeredByHeader === 'string' ? triggeredByHeader : null);

    const result = await ingestManualEntry({
      indicatorCode,
      observationDate: obsDate,
      actual,
      forecast: forecast ?? null,
      previous: previous ?? null,
      notes: notes ?? null,
      triggeredBy,
      confirmRevision,
    });

    // Revision gate: the submitted previous differs from the last stored actual
    // and the caller has not confirmed. Nothing was written. Reply 409 with a
    // distinct body so the frontend can prompt, then re-POST with
    // confirmRevision: true.
    if (isRevisionMismatch(result)) {
      res.status(409).json({
        requiresRevisionConfirmation: true,
        indicatorCode: result.indicatorCode,
        storedActual: result.storedActual,
        storedActualDate: result.storedActualDate,
        submittedPrevious: result.submittedPrevious,
      });
      return;
    }

    res.status(200).json({
      success: true,
      dataPointId: result.dataPointId,
      action: result.action,
      indicator: result.indicator,
      observationDate: result.observationDate.toISOString().slice(0, 10),
      value: result.value,
      isRateDecision: result.isRateDecision,
      ...(result.rateLevel !== undefined ? { rateLevel: result.rateLevel } : {}),
      metadata: {
        forecastValue: result.forecastValue,
        previousValue: result.previousValue,
        notes: result.notes,
      },
    });
  } catch (err) {
    next(err);
  }
}

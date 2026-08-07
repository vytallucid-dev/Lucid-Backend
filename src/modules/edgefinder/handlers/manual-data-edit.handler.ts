import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { editManualEntry } from '@modules/edgefinder/services/manual-data-edit.service';

export const ManualDataEditSchema = z.object({
  observationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO date YYYY-MM-DD').optional(),
  actual: z.number().finite().optional(),
  forecast: z.number().finite().nullable().optional(),
  previous: z.number().finite().nullable().optional(),
  variant: z.string().min(1).max(20).nullable().optional(),
});

export async function manualDataEditHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const dataPointId = req.params.dataPointId as string | undefined;
    if (!dataPointId) {
      throw new AppError(400, 'Missing dataPointId', 'MISSING_DATA_POINT_ID');
    }

    const parsed = ManualDataEditSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid body', 'INVALID_BODY', {
        details: parsed.error.format(),
      });
    }

    const { observationDate, actual, forecast, previous, variant } = parsed.data;

    if (
      observationDate === undefined &&
      actual === undefined &&
      forecast === undefined &&
      previous === undefined &&
      variant === undefined
    ) {
      throw new AppError(400, 'No fields to edit', 'NO_EDITS_PROVIDED');
    }

    let obsDate: Date | undefined;
    if (observationDate !== undefined) {
      obsDate = new Date(`${observationDate}T00:00:00.000Z`);
      if (Number.isNaN(obsDate.getTime())) {
        throw new AppError(400, 'Cannot parse observation date', 'OBSERVATION_DATE_INVALID', {
          observationDate,
        });
      }
      const todayEnd = new Date();
      todayEnd.setUTCHours(23, 59, 59, 999);
      if (obsDate > todayEnd) {
        throw new AppError(400, 'Observation date cannot be in the future', 'OBSERVATION_DATE_INVALID', {
          observationDate,
        });
      }
    }

    const triggeredByHeader = req.headers['x-admin-user'];
    const triggeredBy =
      req.user?.email ?? (typeof triggeredByHeader === 'string' ? triggeredByHeader : null);

    const result = await editManualEntry({
      dataPointId,
      observationDate: obsDate,
      actual,
      forecast,
      previous,
      variant,
      triggeredBy,
    });

    res.status(200).json({
      success: true,
      dataPointId: result.dataPointId,
      indicator: result.indicator,
      observationDate: result.observationDate.toISOString().slice(0, 10),
      variant: result.variant,
      value: result.value,
      forecastValue: result.forecastValue,
      previousValue: result.previousValue,
    });
  } catch (err) {
    next(err);
  }
}

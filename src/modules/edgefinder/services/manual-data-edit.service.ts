import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { logger } from '@core/utils/logger';
import { dataPointsRepository } from '@core/repositories/data-points.repository';

/**
 * B4 edit path — correcting a typo in an already-entered DataPoint.
 *
 * This is deliberately a SEPARATE action from ingestManualEntry
 * (manual-data-entry.service.ts). That service infers "is this a revision?"
 * from whether the submitted `previous` matches the last stored actual —
 * correct for logging a genuinely new release, wrong for fixing a typo in a
 * row that was already entered (that path would manufacture a revision
 * record and a confirmation prompt for what is really just retyping a
 * number correctly). This service never creates a revision record: it
 * overwrites the named row in place, full stop.
 */

export interface EditDataPointInput {
  dataPointId: string;
  observationDate?: Date;
  actual?: number;
  forecast?: number | null;
  previous?: number | null;
  variant?: string | null;
  triggeredBy: string | null;
}

export interface EditDataPointResult {
  dataPointId: string;
  indicator: { code: string; name: string };
  observationDate: Date;
  variant: string | null;
  value: number;
  forecastValue: number | null;
  previousValue: number | null;
}

export async function editManualEntry(input: EditDataPointInput): Promise<EditDataPointResult> {
  const existing = await prisma.dataPoint.findUnique({
    where: { id: input.dataPointId },
    include: { indicator: { select: { id: true, code: true, name: true } } },
  });

  if (!existing) {
    throw new AppError(404, `Data point ${input.dataPointId} not found`, 'DATA_POINT_NOT_FOUND', {
      dataPointId: input.dataPointId,
    });
  }

  // Editing a superseded (isCurrent: false) row would silently rewrite
  // history that scoring and the admin UI both already treat as a past
  // vintage — not what "correct a typo" means. Only the current row for its
  // (indicator, observationDate, variant) is editable; correcting an older
  // vintage isn't a supported operation (nothing reads it as authoritative).
  if (!existing.isCurrent) {
    throw new AppError(
      400,
      'Only the current value can be edited. This row was superseded by a later entry.',
      'DATA_POINT_NOT_CURRENT',
      { dataPointId: input.dataPointId },
    );
  }

  // Variant validation mirrors ingestManualEntry's — data-driven, no
  // hardcoded indicator list. Only checked when the edit actually changes
  // variant; leaving it untouched is always valid regardless of registry
  // state (it was valid when the row was created).
  if (input.variant !== undefined && input.variant !== existing.variant) {
    const registeredVariants = await prisma.indicatorVariant.findMany({
      where: { indicatorId: existing.indicatorId },
      select: { variant: true },
    });
    const isMultiVariant = registeredVariants.length > 0;
    if (isMultiVariant && input.variant === null) {
      throw new AppError(
        400,
        `Indicator ${existing.indicator.code} has multiple release types; a variant must be selected.`,
        'VARIANT_REQUIRED',
        { indicatorCode: existing.indicator.code, allowedVariants: registeredVariants.map((v) => v.variant) },
      );
    }
    if (!isMultiVariant && input.variant !== null) {
      throw new AppError(
        400,
        `Indicator ${existing.indicator.code} is single-release; it does not accept a variant.`,
        'VARIANT_NOT_ALLOWED',
        { indicatorCode: existing.indicator.code },
      );
    }
    if (isMultiVariant && input.variant !== null && !registeredVariants.some((v) => v.variant === input.variant)) {
      throw new AppError(
        400,
        `"${input.variant}" is not a registered variant for ${existing.indicator.code}.`,
        'VARIANT_UNKNOWN',
        { indicatorCode: existing.indicator.code, allowedVariants: registeredVariants.map((v) => v.variant) },
      );
    }
  }

  const updated = await dataPointsRepository.editInPlace(input.dataPointId, {
    observationDate: input.observationDate,
    value: input.actual,
    forecastValue: input.forecast,
    previousValue: input.previous,
    variant: input.variant,
  });

  logger.info(
    {
      dataPointId: input.dataPointId,
      indicatorCode: existing.indicator.code,
      triggeredBy: input.triggeredBy,
      changed: {
        observationDate: input.observationDate !== undefined,
        actual: input.actual !== undefined,
        forecast: input.forecast !== undefined,
        previous: input.previous !== undefined,
        variant: input.variant !== undefined,
      },
    },
    'Manual data point edited in place (no revision created)',
  );

  return {
    dataPointId: updated.id,
    indicator: { code: existing.indicator.code, name: existing.indicator.name },
    observationDate: updated.observationDate,
    variant: updated.variant,
    value: Number(updated.value),
    forecastValue: updated.forecastValue === null ? null : Number(updated.forecastValue),
    previousValue: updated.previousValue === null ? null : Number(updated.previousValue),
  };
}

import { Prisma, DataPoint, DataSource, DataQualityFlag } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';

export type DecimalInput = Prisma.Decimal | number | string;

export interface UpsertDataPointParams {
  indicatorId: string;
  observationDate: Date;
  value: DecimalInput;
  forecastValue?: DecimalInput | null;
  previousValue?: DecimalInput | null;
  source: DataSource;
  sourceMetadata?: Prisma.InputJsonValue;
  fetchedVia?: string | null;
  dataQualityFlag?: DataQualityFlag | null;
  notes?: string | null;
  createdBy?: string | null;
}

export interface UpsertResult {
  action: 'inserted' | 'revised' | 'skipped';
  dataPoint: DataPoint | null;
}

function normalizeOptionalDecimal(v: DecimalInput | null | undefined): Prisma.Decimal | null {
  if (v === null || v === undefined) return null;
  return new Prisma.Decimal(v).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

function optionalDecimalsEqual(
  a: Prisma.Decimal | null,
  b: Prisma.Decimal | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.equals(b);
}

export const dataPointsRepository = {
  /**
   * Upsert a data point with vintage-aware revision handling.
   *
   * Logic:
   *   - If no current row exists for (indicatorId, observationDate): INSERT fresh.
   *   - If current row exists AND value + (if provided) forecast/previous all match: SKIP.
   *   - If anything compared differs: INSERT new vintage, flip prior to is_current=false.
   *
   * `forecastValue` and `previousValue` are only included in the comparison when the
   * caller passes them (i.e., not `undefined`). Passing `null` explicitly is treated as
   * "this field should be null" and IS compared — so a backfill from null→value triggers
   * a revision exactly once.
   *
   * Idempotent: re-running with same payload is a no-op.
   */
  async upsert(params: UpsertDataPointParams): Promise<UpsertResult> {
    // Round to 6 decimal places to match Postgres column precision Decimal(20, 6).
    const incomingValue = new Prisma.Decimal(params.value).toDecimalPlaces(
      6,
      Prisma.Decimal.ROUND_HALF_UP,
    );

    const forecastProvided = params.forecastValue !== undefined;
    const previousProvided = params.previousValue !== undefined;
    const incomingForecast = forecastProvided
      ? normalizeOptionalDecimal(params.forecastValue ?? null)
      : null;
    const incomingPrevious = previousProvided
      ? normalizeOptionalDecimal(params.previousValue ?? null)
      : null;

    return prisma.$transaction(async (tx) => {
      const existing = await tx.dataPoint.findFirst({
        where: {
          indicatorId: params.indicatorId,
          observationDate: params.observationDate,
          isCurrent: true,
        },
      });

      if (existing) {
        const existingValue = new Prisma.Decimal(existing.value.toString());
        const existingForecast =
          existing.forecastValue === null ? null : new Prisma.Decimal(existing.forecastValue.toString());
        const existingPrevious =
          existing.previousValue === null ? null : new Prisma.Decimal(existing.previousValue.toString());

        const valueMatches = existingValue.equals(incomingValue);
        const forecastMatches = !forecastProvided || optionalDecimalsEqual(existingForecast, incomingForecast);
        const previousMatches = !previousProvided || optionalDecimalsEqual(existingPrevious, incomingPrevious);

        if (valueMatches && forecastMatches && previousMatches) {
          return { action: 'skipped', dataPoint: existing };
        }

        logger.info(
          {
            indicatorId: params.indicatorId,
            observationDate: params.observationDate,
            previousValue: existingValue.toString(),
            newValue: incomingValue.toString(),
            forecastChanged: !forecastMatches,
            previousChanged: !previousMatches,
          },
          'Revision detected — inserting new vintage',
        );

        await tx.dataPoint.update({
          where: { id: existing.id },
          data: { isCurrent: false },
        });

        const inserted = await tx.dataPoint.create({
          data: {
            indicatorId: params.indicatorId,
            observationDate: params.observationDate,
            value: incomingValue,
            forecastValue: forecastProvided ? incomingForecast : existingForecast,
            previousValue: previousProvided ? incomingPrevious : existingPrevious,
            isCurrent: true,
            source: params.source,
            sourceMetadata: params.sourceMetadata ?? Prisma.JsonNull,
            fetchedVia: params.fetchedVia ?? null,
            dataQualityFlag: params.dataQualityFlag ?? 'revised',
            notes: params.notes ?? null,
            createdBy: params.createdBy ?? null,
          },
        });

        return { action: 'revised', dataPoint: inserted };
      }

      const inserted = await tx.dataPoint.create({
        data: {
          indicatorId: params.indicatorId,
          observationDate: params.observationDate,
          value: incomingValue,
          forecastValue: incomingForecast,
          previousValue: incomingPrevious,
          isCurrent: true,
          source: params.source,
          sourceMetadata: params.sourceMetadata ?? Prisma.JsonNull,
          fetchedVia: params.fetchedVia ?? null,
          dataQualityFlag: params.dataQualityFlag ?? null,
          notes: params.notes ?? null,
          createdBy: params.createdBy ?? null,
        },
      });

      return { action: 'inserted', dataPoint: inserted };
    });
  },

  /**
   * Returns the most recent observation_date we have for an indicator,
   * considering only currently active vintages.
   */
  async getLatestObservationDate(indicatorId: string): Promise<Date | null> {
    const latest = await prisma.dataPoint.findFirst({
      where: { indicatorId, isCurrent: true },
      orderBy: { observationDate: 'desc' },
      select: { observationDate: true },
    });
    return latest?.observationDate ?? null;
  },
};

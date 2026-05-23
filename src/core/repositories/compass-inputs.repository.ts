import { Prisma, DataSource } from '@prisma/client';
import { prisma } from '@core/db/prisma';

export type ColorBand = 'GREEN' | 'YELLOW' | 'RED';
export type CompassSource = Extract<DataSource, 'yahoo' | 'fred' | 'derived'>;

export interface UpsertCompassInputInput {
  observationDate: Date;
  inputCode: string;
  rawValue: number | null;
  derivedValue: number | null;
  colorBand: ColorBand;
  subChecks: Prisma.InputJsonValue | null;
  source: CompassSource;
  isValidation?: boolean;
}

export interface UpsertCompassInputResult {
  id: string;
  action: 'inserted' | 'updated' | 'skipped';
}

function toDecimal6(n: number | null): Prisma.Decimal | null {
  if (n === null) return null;
  return new Prisma.Decimal(n).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

function decimalEquals(
  a: Prisma.Decimal | null,
  b: Prisma.Decimal | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.equals(b);
}

function jsonEquals(
  a: Prisma.JsonValue | null,
  b: Prisma.InputJsonValue | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export const compassInputsRepository = {
  /**
   * Upsert a single compass input row keyed by (observationDate, inputCode,
   * isValidation). Live and validation rows for the same date+code coexist
   * in separate spaces. Compass inputs are recomputed daily and do not
   * vintage — same-key re-runs either update in place or skip if values
   * match.
   */
  async upsert(input: UpsertCompassInputInput): Promise<UpsertCompassInputResult> {
    const rawDecimal = toDecimal6(input.rawValue);
    const derivedDecimal = toDecimal6(input.derivedValue);
    const isValidation = input.isValidation ?? false;

    return prisma.$transaction(async (tx) => {
      const existing = await tx.compassInput.findUnique({
        where: {
          observationDate_inputCode_isValidation: {
            observationDate: input.observationDate,
            inputCode: input.inputCode,
            isValidation,
          },
        },
      });

      if (existing) {
        const existingRaw =
          existing.rawValue === null ? null : new Prisma.Decimal(existing.rawValue.toString());
        const existingDerived =
          existing.derivedValue === null
            ? null
            : new Prisma.Decimal(existing.derivedValue.toString());

        const matches =
          decimalEquals(existingRaw, rawDecimal) &&
          decimalEquals(existingDerived, derivedDecimal) &&
          existing.colorBand === input.colorBand &&
          existing.source === input.source &&
          jsonEquals(existing.subChecks, input.subChecks);

        if (matches) {
          return { id: existing.id, action: 'skipped' as const };
        }

        const updated = await tx.compassInput.update({
          where: { id: existing.id },
          data: {
            rawValue: rawDecimal,
            derivedValue: derivedDecimal,
            colorBand: input.colorBand,
            subChecks: input.subChecks ?? Prisma.JsonNull,
            source: input.source,
            computedAt: new Date(),
          },
        });
        return { id: updated.id, action: 'updated' as const };
      }

      const inserted = await tx.compassInput.create({
        data: {
          observationDate: input.observationDate,
          inputCode: input.inputCode,
          rawValue: rawDecimal,
          derivedValue: derivedDecimal,
          colorBand: input.colorBand,
          subChecks: input.subChecks ?? Prisma.JsonNull,
          source: input.source,
          isValidation,
        },
      });
      return { id: inserted.id, action: 'inserted' as const };
    });
  },
};

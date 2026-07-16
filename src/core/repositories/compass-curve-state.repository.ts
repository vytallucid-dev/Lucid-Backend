import { prisma } from '@core/db/prisma';

export interface CurveStateSnapshot {
  computedForDate: Date;
  inversionStart: Date | null;
  unInversionDate: Date | null;
}

export interface UpsertCurveStateInput {
  computedForDate: Date;
  inversionStart: Date | null;
  unInversionDate: Date | null;
  isValidation?: boolean;
}

/**
 * Cache of the most-recently-scanned T10Y2Y inversion episode. This is NOT
 * the source of truth — compass_curve_state can be wiped entirely and fully
 * rebuilt by re-scanning T10Y2Y history via compass-curve-state-machine.ts.
 * One current row per isValidation space.
 */
export const compassCurveStateRepository = {
  async get(isValidation: boolean = false): Promise<CurveStateSnapshot | null> {
    const row = await prisma.compassCurveState.findUnique({
      where: { isValidation },
    });
    if (!row) return null;
    return {
      computedForDate: row.computedForDate,
      inversionStart: row.inversionStart,
      unInversionDate: row.unInversionDate,
    };
  },

  async upsert(input: UpsertCurveStateInput): Promise<void> {
    const isValidation = input.isValidation ?? false;
    await prisma.compassCurveState.upsert({
      where: { isValidation },
      update: {
        computedForDate: input.computedForDate,
        inversionStart: input.inversionStart,
        unInversionDate: input.unInversionDate,
      },
      create: {
        isValidation,
        computedForDate: input.computedForDate,
        inversionStart: input.inversionStart,
        unInversionDate: input.unInversionDate,
      },
    });
  },
};

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
  researchTag?: string;
}

/**
 * Cache of the most-recently-scanned T10Y2Y inversion episode. This is NOT
 * the source of truth — compass_curve_state can be wiped entirely and fully
 * rebuilt by re-scanning T10Y2Y history via compass-curve-state-machine.ts.
 * One current row per (isValidation, researchTag) space.
 */
/**
 * Phase C: `researchTag` widens the singleton key. Both caches were keyed on
 * isValidation alone, so a replay run would have overwritten live state. '' is
 * the live space; a replay passes its own tag and gets its own row.
 */
export const compassCurveStateRepository = {
  async get(
    isValidation: boolean = false,
    researchTag: string = '',
  ): Promise<CurveStateSnapshot | null> {
    const row = await prisma.compassCurveState.findUnique({
      where: { isValidation_researchTag: { isValidation, researchTag } },
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
    const researchTag = input.researchTag ?? '';
    await prisma.compassCurveState.upsert({
      where: { isValidation_researchTag: { isValidation, researchTag } },
      update: {
        computedForDate: input.computedForDate,
        inversionStart: input.inversionStart,
        unInversionDate: input.unInversionDate,
      },
      create: {
        isValidation,
        researchTag,
        computedForDate: input.computedForDate,
        inversionStart: input.inversionStart,
        unInversionDate: input.unInversionDate,
      },
    });
  },
};

import { prisma } from '@core/db/prisma';

export interface ShockStateSnapshot {
  computedForDate: Date;
  shockAActive: boolean;
  shockAExpiry: Date | null;
  shockBActive: boolean;
  shockBExpiry: Date | null;
}

export interface UpsertShockStateInput {
  computedForDate: Date;
  shockAActive: boolean;
  shockAExpiry: Date | null;
  shockBActive: boolean;
  shockBExpiry: Date | null;
  isValidation?: boolean;
  researchTag?: string;
}

/**
 * Cache of the Shock Layer's two trigger states (Trigger A / Vol Shock,
 * Trigger B / Carry Shock). This is NOT the source of truth —
 * compass_shock_state can be wiped entirely and fully rebuilt by re-scanning
 * VIX/OAS/USDJPY history via compass-shock-layer.ts. One current row per
 * (isValidation, researchTag) space, mirroring compass-curve-state.repository.ts
 * exactly.
 */
/**
 * Phase C: `researchTag` widens the singleton key. Both caches were keyed on
 * isValidation alone, so a replay run would have overwritten live state. '' is
 * the live space; a replay passes its own tag and gets its own row.
 */
export const compassShockStateRepository = {
  async get(
    isValidation: boolean = false,
    researchTag: string = '',
  ): Promise<ShockStateSnapshot | null> {
    const row = await prisma.compassShockState.findUnique({
      where: { isValidation_researchTag: { isValidation, researchTag } },
    });
    if (!row) return null;
    return {
      computedForDate: row.computedForDate,
      shockAActive: row.shockAActive,
      shockAExpiry: row.shockAExpiry,
      shockBActive: row.shockBActive,
      shockBExpiry: row.shockBExpiry,
    };
  },

  async upsert(input: UpsertShockStateInput): Promise<void> {
    const isValidation = input.isValidation ?? false;
    const researchTag = input.researchTag ?? '';
    await prisma.compassShockState.upsert({
      where: { isValidation_researchTag: { isValidation, researchTag } },
      update: {
        computedForDate: input.computedForDate,
        shockAActive: input.shockAActive,
        shockAExpiry: input.shockAExpiry,
        shockBActive: input.shockBActive,
        shockBExpiry: input.shockBExpiry,
      },
      create: {
        isValidation,
        researchTag,
        computedForDate: input.computedForDate,
        shockAActive: input.shockAActive,
        shockAExpiry: input.shockAExpiry,
        shockBActive: input.shockBActive,
        shockBExpiry: input.shockBExpiry,
      },
    });
  },
};

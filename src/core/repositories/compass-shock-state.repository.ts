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
}

/**
 * Cache of the Shock Layer's two trigger states (Trigger A / Vol Shock,
 * Trigger B / Carry Shock). This is NOT the source of truth —
 * compass_shock_state can be wiped entirely and fully rebuilt by re-scanning
 * VIX/OAS/USDJPY history via compass-shock-layer.ts. One current row per
 * isValidation space, mirroring compass-curve-state.repository.ts exactly.
 */
export const compassShockStateRepository = {
  async get(isValidation: boolean = false): Promise<ShockStateSnapshot | null> {
    const row = await prisma.compassShockState.findUnique({
      where: { isValidation },
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
    await prisma.compassShockState.upsert({
      where: { isValidation },
      update: {
        computedForDate: input.computedForDate,
        shockAActive: input.shockAActive,
        shockAExpiry: input.shockAExpiry,
        shockBActive: input.shockBActive,
        shockBExpiry: input.shockBExpiry,
      },
      create: {
        isValidation,
        computedForDate: input.computedForDate,
        shockAActive: input.shockAActive,
        shockAExpiry: input.shockAExpiry,
        shockBActive: input.shockBActive,
        shockBExpiry: input.shockBExpiry,
      },
    });
  },
};

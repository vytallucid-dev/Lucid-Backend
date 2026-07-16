import { prisma } from '@core/db/prisma';
import type { CompassConfigDefinition } from '@modules/edgefinder/services/compass/compass-config.types';

const EXPECTED_WEIGHT_TOTAL = 8.0;
const WEIGHT_TOTAL_EPSILON = 1e-9;

/**
 * Vote weights must sum to exactly 8.0 — determineCandidateRegime's
 * red/green thresholds are calibrated against that total. A misconfigured
 * weight map would silently mis-score every classification, so this fails
 * loudly instead.
 */
function assertWeightsSumToEight(config: CompassConfigDefinition, versionLabel: string): void {
  const total = Object.values(config.weights).reduce((s, w) => s + w, 0);
  if (Math.abs(total - EXPECTED_WEIGHT_TOTAL) > WEIGHT_TOTAL_EPSILON) {
    throw new Error(
      `compass_config '${versionLabel}': weights sum to ${total}, expected exactly ${EXPECTED_WEIGHT_TOTAL}`,
    );
  }
}

export const compassConfigRepository = {
  /**
   * Resolve the active Compass config for a given date: the row whose
   * [effectiveFrom, effectiveTo] range covers the date, highest versionLabel
   * ordering by effectiveFrom desc as the tiebreaker. Mirrors the ScoringRule
   * resolution query (effectiveFrom <= date AND (effectiveTo IS NULL OR
   * effectiveTo >= date)).
   */
  async resolveForDate(date: Date): Promise<CompassConfigDefinition> {
    const row = await prisma.compassConfig.findFirst({
      where: {
        effectiveFrom: { lte: date },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (!row) {
      throw new Error(`No active compass_config row covers date ${date.toISOString().slice(0, 10)}`);
    }

    const config = row.configDefinition as unknown as CompassConfigDefinition;
    assertWeightsSumToEight(config, row.versionLabel);
    return config;
  },
};

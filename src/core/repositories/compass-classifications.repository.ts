import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';

export type Regime = 'Risk-On' | 'Caution' | 'Risk-Off';

export interface UpsertCompassClassificationInput {
  classificationDate: Date;
  candidateRegime: Regime;
  activeRegime: Regime;
  persistenceDaysCount: number;
  crisisOverrideFired: boolean;
  totalGreenWeight: number;
  totalYellowWeight: number;
  totalRedWeight: number;
  voteBreakdown: Prisma.InputJsonValue;
  isValidation?: boolean;
}

export interface UpsertCompassClassificationResult {
  id: string;
  action: 'inserted' | 'revised' | 'skipped';
}

export interface PriorClassificationSnapshot {
  classificationDate: Date;
  activeRegime: Regime;
  candidateRegime: Regime;
  persistenceDaysCount: number;
}

function toDecimal2(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function decimalEquals(a: Prisma.Decimal, b: Prisma.Decimal): boolean {
  return a.equals(b);
}

export const compassClassificationsRepository = {
  /**
   * Vintage-aware upsert for a Compass classification row.
   *
   * Live and validation rows live in disjoint spaces via the isValidation
   * flag — current-row lookup and revision both scope to the same flag.
   */
  async upsert(
    input: UpsertCompassClassificationInput,
  ): Promise<UpsertCompassClassificationResult> {
    const incomingGreen = toDecimal2(input.totalGreenWeight);
    const incomingYellow = toDecimal2(input.totalYellowWeight);
    const incomingRed = toDecimal2(input.totalRedWeight);
    const isValidation = input.isValidation ?? false;

    return prisma.$transaction(async (tx) => {
      const existing = await tx.compassClassification.findFirst({
        where: {
          classificationDate: input.classificationDate,
          isCurrent: true,
          isValidation,
        },
      });

      if (existing) {
        const existingGreen = new Prisma.Decimal(existing.totalGreenWeight.toString());
        const existingYellow = new Prisma.Decimal(existing.totalYellowWeight.toString());
        const existingRed = new Prisma.Decimal(existing.totalRedWeight.toString());

        const matches =
          existing.candidateRegime === input.candidateRegime &&
          existing.activeRegime === input.activeRegime &&
          existing.persistenceDaysCount === input.persistenceDaysCount &&
          existing.crisisOverrideFired === input.crisisOverrideFired &&
          decimalEquals(existingGreen, incomingGreen) &&
          decimalEquals(existingYellow, incomingYellow) &&
          decimalEquals(existingRed, incomingRed) &&
          JSON.stringify(existing.voteBreakdown) === JSON.stringify(input.voteBreakdown);

        if (matches) {
          return { id: existing.id, action: 'skipped' as const };
        }

        logger.info(
          {
            classificationDate: input.classificationDate.toISOString().slice(0, 10),
            priorActive: existing.activeRegime,
            newActive: input.activeRegime,
            isValidation,
          },
          'Compass classification revision — inserting new vintage',
        );

        await tx.compassClassification.update({
          where: { id: existing.id },
          data: { isCurrent: false },
        });

        const inserted = await tx.compassClassification.create({
          data: {
            classificationDate: input.classificationDate,
            candidateRegime: input.candidateRegime,
            activeRegime: input.activeRegime,
            persistenceDaysCount: input.persistenceDaysCount,
            crisisOverrideFired: input.crisisOverrideFired,
            totalGreenWeight: incomingGreen,
            totalYellowWeight: incomingYellow,
            totalRedWeight: incomingRed,
            voteBreakdown: input.voteBreakdown,
            isCurrent: true,
            isValidation,
          },
        });

        return { id: inserted.id, action: 'revised' as const };
      }

      const inserted = await tx.compassClassification.create({
        data: {
          classificationDate: input.classificationDate,
          candidateRegime: input.candidateRegime,
          activeRegime: input.activeRegime,
          persistenceDaysCount: input.persistenceDaysCount,
          crisisOverrideFired: input.crisisOverrideFired,
          totalGreenWeight: incomingGreen,
          totalYellowWeight: incomingYellow,
          totalRedWeight: incomingRed,
          voteBreakdown: input.voteBreakdown,
          isCurrent: true,
          isValidation,
        },
      });

      return { id: inserted.id, action: 'inserted' as const };
    });
  },

  /**
   * Get the most recent current classification strictly before `date` in the
   * same validation space. Used to look up "yesterday's" state when
   * resolving today's persistence.
   */
  async getMostRecentBefore(
    date: Date,
    isValidation: boolean = false,
  ): Promise<PriorClassificationSnapshot | null> {
    const row = await prisma.compassClassification.findFirst({
      where: {
        isCurrent: true,
        isValidation,
        classificationDate: { lt: date },
      },
      orderBy: { classificationDate: 'desc' },
    });

    if (!row) return null;

    return {
      classificationDate: row.classificationDate,
      activeRegime: row.activeRegime as Regime,
      candidateRegime: row.candidateRegime as Regime,
      persistenceDaysCount: row.persistenceDaysCount,
    };
  },

  /**
   * Get the regime in effect AS OF `date` in the same validation space.
   * Prefers the classification row for `date` itself; otherwise falls back
   * to the most recent prior current row.
   */
  async getRegimeAsOf(
    date: Date,
    isValidation: boolean = false,
  ): Promise<PriorClassificationSnapshot | null> {
    const row = await prisma.compassClassification.findFirst({
      where: {
        isCurrent: true,
        isValidation,
        classificationDate: { lte: date },
      },
      orderBy: { classificationDate: 'desc' },
    });

    if (!row) return null;

    return {
      classificationDate: row.classificationDate,
      activeRegime: row.activeRegime as Regime,
      candidateRegime: row.candidateRegime as Regime,
      persistenceDaysCount: row.persistenceDaysCount,
    };
  },
};

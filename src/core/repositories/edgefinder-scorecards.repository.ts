import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';

export type Regime = 'Risk-On' | 'Caution' | 'Risk-Off';

export interface UpsertScorecardInput {
  assetId: string;
  observationDate: Date;
  baseFundamentalsScore: number;
  fundamentalsScore: number;
  cotScore: number;
  compassAdjustment: number;
  compassOverridesApplied: Prisma.InputJsonValue | null;
  regimeAtCompute: Regime | null;
  totalScore: number;
  ratingLabel: string;
  indicatorBreakdown: Prisma.InputJsonValue;
  cotBreakdown: Prisma.InputJsonValue | null;
}

export interface UpsertScorecardResult {
  scorecardId: string;
  action: 'inserted' | 'revised' | 'skipped';
}

export interface CurrentScorecardSnapshot {
  id: string;
  assetId: string;
  observationDate: Date;
  baseFundamentalsScore: number;
  fundamentalsScore: number;
  cotScore: number;
  compassAdjustment: number;
  totalScore: number;
  ratingLabel: string;
  regimeAtCompute: Regime | null;
}

function jsonEquals(
  a: Prisma.JsonValue | null,
  b: Prisma.InputJsonValue | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export const edgefinderScorecardsRepository = {
  /**
   * Vintage-aware upsert. No prior current row → INSERT. Match on all numeric
   * fields + labels + JSON breakdowns → SKIP. Differs → flip prior isCurrent
   * to false and insert new vintage → REVISED.
   */
  async upsert(input: UpsertScorecardInput): Promise<UpsertScorecardResult> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.edgefinderScorecard.findFirst({
        where: {
          assetId: input.assetId,
          observationDate: input.observationDate,
          isCurrent: true,
        },
      });

      if (existing) {
        const matches =
          existing.baseFundamentalsScore === input.baseFundamentalsScore &&
          existing.fundamentalsScore === input.fundamentalsScore &&
          existing.cotScore === input.cotScore &&
          existing.compassAdjustment === input.compassAdjustment &&
          existing.totalScore === input.totalScore &&
          existing.ratingLabel === input.ratingLabel &&
          existing.regimeAtCompute === input.regimeAtCompute &&
          jsonEquals(existing.compassOverridesApplied, input.compassOverridesApplied) &&
          jsonEquals(existing.indicatorBreakdown, input.indicatorBreakdown) &&
          jsonEquals(existing.cotBreakdown, input.cotBreakdown);

        if (matches) {
          return { scorecardId: existing.id, action: 'skipped' as const };
        }

        logger.info(
          {
            assetId: input.assetId,
            observationDate: input.observationDate.toISOString().slice(0, 10),
            priorTotal: existing.totalScore,
            newTotal: input.totalScore,
          },
          'EdgeFinder scorecard revision — inserting new vintage',
        );

        await tx.edgefinderScorecard.update({
          where: { id: existing.id },
          data: { isCurrent: false },
        });

        const inserted = await tx.edgefinderScorecard.create({
          data: {
            assetId: input.assetId,
            observationDate: input.observationDate,
            baseFundamentalsScore: input.baseFundamentalsScore,
            fundamentalsScore: input.fundamentalsScore,
            cotScore: input.cotScore,
            compassAdjustment: input.compassAdjustment,
            compassOverridesApplied:
              input.compassOverridesApplied ?? Prisma.JsonNull,
            regimeAtCompute: input.regimeAtCompute,
            totalScore: input.totalScore,
            ratingLabel: input.ratingLabel,
            indicatorBreakdown: input.indicatorBreakdown,
            cotBreakdown: input.cotBreakdown ?? Prisma.JsonNull,
            isCurrent: true,
          },
        });
        return { scorecardId: inserted.id, action: 'revised' as const };
      }

      const inserted = await tx.edgefinderScorecard.create({
        data: {
          assetId: input.assetId,
          observationDate: input.observationDate,
          baseFundamentalsScore: input.baseFundamentalsScore,
          fundamentalsScore: input.fundamentalsScore,
          cotScore: input.cotScore,
          compassAdjustment: input.compassAdjustment,
          compassOverridesApplied:
            input.compassOverridesApplied ?? Prisma.JsonNull,
          regimeAtCompute: input.regimeAtCompute,
          totalScore: input.totalScore,
          ratingLabel: input.ratingLabel,
          indicatorBreakdown: input.indicatorBreakdown,
          cotBreakdown: input.cotBreakdown ?? Prisma.JsonNull,
          isCurrent: true,
        },
      });
      return { scorecardId: inserted.id, action: 'inserted' as const };
    });
  },

  async getCurrent(
    assetId: string,
    observationDate: Date,
  ): Promise<CurrentScorecardSnapshot | null> {
    const row = await prisma.edgefinderScorecard.findFirst({
      where: {
        assetId,
        observationDate,
        isCurrent: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      assetId: row.assetId,
      observationDate: row.observationDate,
      baseFundamentalsScore: row.baseFundamentalsScore,
      fundamentalsScore: row.fundamentalsScore,
      cotScore: row.cotScore,
      compassAdjustment: row.compassAdjustment,
      totalScore: row.totalScore,
      ratingLabel: row.ratingLabel,
      regimeAtCompute: row.regimeAtCompute as Regime | null,
    };
  },
};

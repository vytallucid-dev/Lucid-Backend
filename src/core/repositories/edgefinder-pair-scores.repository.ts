import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';

export type Regime = 'Risk-On' | 'Caution' | 'Risk-Off';

export interface UpsertPairScoreInput {
  pairId: string;
  scoreDate: Date;
  basePairScore: number;
  pairCotScore: number;
  baseTotal: number;
  compassAdjustment: number;
  compassOverridesApplied: Prisma.InputJsonValue | null;
  regimeAtCompute: Regime | null;
  totalScore: number;
  ratingLabel: string;
  rowBreakdown: Prisma.InputJsonValue;
  cotBreakdown: Prisma.InputJsonValue | null;
}

export interface UpsertPairScoreResult {
  pairScoreId: string;
  action: 'inserted' | 'revised' | 'skipped';
}

export interface CurrentPairScoreSnapshot {
  id: string;
  pairId: string;
  scoreDate: Date;
  basePairScore: number;
  pairCotScore: number;
  baseTotal: number;
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

export const edgefinderPairScoresRepository = {
  /**
   * Vintage-aware upsert. No prior current row → INSERT. Match on all numeric
   * fields + label + JSON breakdowns → SKIP. Differs → flip prior isCurrent
   * to false and insert a new vintage → REVISED.
   */
  async upsert(input: UpsertPairScoreInput): Promise<UpsertPairScoreResult> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.edgefinderPairScore.findFirst({
        where: {
          pairId: input.pairId,
          scoreDate: input.scoreDate,
          isCurrent: true,
        },
      });

      if (existing) {
        const matches =
          existing.basePairScore === input.basePairScore &&
          existing.pairCotScore === input.pairCotScore &&
          existing.baseTotal === input.baseTotal &&
          existing.compassAdjustment === input.compassAdjustment &&
          existing.totalScore === input.totalScore &&
          existing.ratingLabel === input.ratingLabel &&
          existing.regimeAtCompute === input.regimeAtCompute &&
          jsonEquals(existing.compassOverridesApplied, input.compassOverridesApplied) &&
          jsonEquals(existing.rowBreakdown, input.rowBreakdown) &&
          jsonEquals(existing.cotBreakdown, input.cotBreakdown);

        if (matches) {
          return { pairScoreId: existing.id, action: 'skipped' as const };
        }

        logger.info(
          {
            pairId: input.pairId,
            scoreDate: input.scoreDate.toISOString().slice(0, 10),
            priorTotal: existing.totalScore,
            newTotal: input.totalScore,
          },
          'EdgeFinder pair score revision — inserting new vintage',
        );

        await tx.edgefinderPairScore.update({
          where: { id: existing.id },
          data: { isCurrent: false },
        });

        const inserted = await tx.edgefinderPairScore.create({
          data: {
            pairId: input.pairId,
            scoreDate: input.scoreDate,
            basePairScore: input.basePairScore,
            pairCotScore: input.pairCotScore,
            baseTotal: input.baseTotal,
            compassAdjustment: input.compassAdjustment,
            compassOverridesApplied:
              input.compassOverridesApplied ?? Prisma.JsonNull,
            regimeAtCompute: input.regimeAtCompute,
            totalScore: input.totalScore,
            ratingLabel: input.ratingLabel,
            rowBreakdown: input.rowBreakdown,
            cotBreakdown: input.cotBreakdown ?? Prisma.JsonNull,
            isCurrent: true,
          },
        });
        return { pairScoreId: inserted.id, action: 'revised' as const };
      }

      const inserted = await tx.edgefinderPairScore.create({
        data: {
          pairId: input.pairId,
          scoreDate: input.scoreDate,
          basePairScore: input.basePairScore,
          pairCotScore: input.pairCotScore,
          baseTotal: input.baseTotal,
          compassAdjustment: input.compassAdjustment,
          compassOverridesApplied:
            input.compassOverridesApplied ?? Prisma.JsonNull,
          regimeAtCompute: input.regimeAtCompute,
          totalScore: input.totalScore,
          ratingLabel: input.ratingLabel,
          rowBreakdown: input.rowBreakdown,
          cotBreakdown: input.cotBreakdown ?? Prisma.JsonNull,
          isCurrent: true,
        },
      });
      return { pairScoreId: inserted.id, action: 'inserted' as const };
    });
  },

  async getCurrent(
    pairId: string,
    scoreDate: Date,
  ): Promise<CurrentPairScoreSnapshot | null> {
    const row = await prisma.edgefinderPairScore.findFirst({
      where: {
        pairId,
        scoreDate,
        isCurrent: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      pairId: row.pairId,
      scoreDate: row.scoreDate,
      basePairScore: row.basePairScore,
      pairCotScore: row.pairCotScore,
      baseTotal: row.baseTotal,
      compassAdjustment: row.compassAdjustment,
      totalScore: row.totalScore,
      ratingLabel: row.ratingLabel,
      regimeAtCompute: row.regimeAtCompute as Regime | null,
    };
  },
};

import { Prisma, DataSource } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';

export interface UpsertCotDataInput {
  assetId: string;
  contractCode: string;
  reportDate: Date;
  releaseDate: Date;
  traderCategory: string;
  longContracts: number;
  shortContracts: number;
  longPct: number;
  shortPct: number;
  changeInLongContracts: number;
  changeInShortContracts: number;
  changeInLongPct: number | null;
  changeInShortPct: number | null;
  weeklyChangePct: number | null;
  netPositioningLabel: string;
  changeLabel: string;
  source: Extract<DataSource, 'cftc'>;
  rawPayload: Prisma.InputJsonValue;
}

export interface UpsertCotDataResult {
  cotDataId: string;
  action: 'inserted' | 'revised' | 'skipped';
}

function toDecimal4(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

function toOptionalDecimal4(n: number | null): Prisma.Decimal | null {
  return n === null ? null : toDecimal4(n);
}

function optionalDecimalEquals(
  a: Prisma.Decimal | null,
  b: Prisma.Decimal | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.equals(b);
}

export const cotDataRepository = {
  /**
   * Vintage-aware upsert for a single COT data row.
   *
   *   - If no current row exists for (contractCode, reportDate, traderCategory): INSERT.
   *   - If current row exists and all numeric fields match (Decimal(8,4) precision):
   *     SKIP.
   *   - Otherwise: flip prior row to is_current=false and INSERT a fresh vintage
   *     marked is_current=true → REVISED.
   */
  async upsert(input: UpsertCotDataInput): Promise<UpsertCotDataResult> {
    const incomingLongPct = toDecimal4(input.longPct);
    const incomingShortPct = toDecimal4(input.shortPct);
    const incomingChangeInLongPct = toOptionalDecimal4(input.changeInLongPct);
    const incomingChangeInShortPct = toOptionalDecimal4(input.changeInShortPct);
    const incomingWeeklyChangePct = toOptionalDecimal4(input.weeklyChangePct);

    return prisma.$transaction(async (tx) => {
      const existing = await tx.cotData.findFirst({
        where: {
          contractCode: input.contractCode,
          reportDate: input.reportDate,
          traderCategory: input.traderCategory,
          isCurrent: true,
        },
      });

      if (existing) {
        const existingLongPct =
          existing.longPct === null ? null : new Prisma.Decimal(existing.longPct.toString());
        const existingShortPct =
          existing.shortPct === null ? null : new Prisma.Decimal(existing.shortPct.toString());
        const existingChangeInLongPct =
          existing.changeInLongPct === null
            ? null
            : new Prisma.Decimal(existing.changeInLongPct.toString());
        const existingChangeInShortPct =
          existing.changeInShortPct === null
            ? null
            : new Prisma.Decimal(existing.changeInShortPct.toString());
        const existingWeeklyChangePct =
          existing.weeklyChangePct === null
            ? null
            : new Prisma.Decimal(existing.weeklyChangePct.toString());

        const matches =
          existing.longContracts === input.longContracts &&
          existing.shortContracts === input.shortContracts &&
          existing.changeInLongContracts === input.changeInLongContracts &&
          existing.changeInShortContracts === input.changeInShortContracts &&
          optionalDecimalEquals(existingLongPct, incomingLongPct) &&
          optionalDecimalEquals(existingShortPct, incomingShortPct) &&
          optionalDecimalEquals(existingChangeInLongPct, incomingChangeInLongPct) &&
          optionalDecimalEquals(existingChangeInShortPct, incomingChangeInShortPct) &&
          optionalDecimalEquals(existingWeeklyChangePct, incomingWeeklyChangePct) &&
          existing.netPositioningLabel === input.netPositioningLabel &&
          existing.changeLabel === input.changeLabel;

        if (matches) {
          return { cotDataId: existing.id, action: 'skipped' as const };
        }

        logger.info(
          {
            contractCode: input.contractCode,
            reportDate: input.reportDate.toISOString(),
            traderCategory: input.traderCategory,
          },
          'COT revision detected — inserting new vintage',
        );

        await tx.cotData.update({
          where: { id: existing.id },
          data: { isCurrent: false },
        });

        const inserted = await tx.cotData.create({
          data: {
            assetId: input.assetId,
            contractCode: input.contractCode,
            reportDate: input.reportDate,
            releaseDate: input.releaseDate,
            traderCategory: input.traderCategory,
            longContracts: input.longContracts,
            shortContracts: input.shortContracts,
            longPct: incomingLongPct,
            shortPct: incomingShortPct,
            changeInLongContracts: input.changeInLongContracts,
            changeInShortContracts: input.changeInShortContracts,
            changeInLongPct: incomingChangeInLongPct,
            changeInShortPct: incomingChangeInShortPct,
            weeklyChangePct: incomingWeeklyChangePct,
            netPositioningLabel: input.netPositioningLabel,
            changeLabel: input.changeLabel,
            source: input.source,
            rawPayload: input.rawPayload,
            isCurrent: true,
          },
        });

        return { cotDataId: inserted.id, action: 'revised' as const };
      }

      const inserted = await tx.cotData.create({
        data: {
          assetId: input.assetId,
          contractCode: input.contractCode,
          reportDate: input.reportDate,
          releaseDate: input.releaseDate,
          traderCategory: input.traderCategory,
          longContracts: input.longContracts,
          shortContracts: input.shortContracts,
          longPct: incomingLongPct,
          shortPct: incomingShortPct,
          changeInLongContracts: input.changeInLongContracts,
          changeInShortContracts: input.changeInShortContracts,
          changeInLongPct: incomingChangeInLongPct,
          changeInShortPct: incomingChangeInShortPct,
          weeklyChangePct: incomingWeeklyChangePct,
          netPositioningLabel: input.netPositioningLabel,
          changeLabel: input.changeLabel,
          source: input.source,
          rawPayload: input.rawPayload,
          isCurrent: true,
        },
      });

      return { cotDataId: inserted.id, action: 'inserted' as const };
    });
  },
};

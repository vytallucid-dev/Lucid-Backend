import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { ScoringContext, ScoringResult, Score } from '../../types';
import { classifyNetPositioning, classifyChangePercent } from './cot-label.helpers';
import { combineCotLabelsForAsset } from './cot-combination';

/**
 * COT two-component scoring handler.
 *
 * Rule definition shape:
 *   { type: 'cot_two_component', asset_code: 'USD' }
 *
 * Resolves: ruleDefinition.asset_code → assets row → metadata.cotContractCode +
 * metadata.cotTraderCategory → most recent current cot_data row on or before
 * the observation date. Classifies Net Positioning (long_pct) and Change %
 * (weekly_change_pct), combines them via the locked 3x3 asset matrix.
 */
export async function cotTwoComponentHandler(ctx: ScoringContext): Promise<ScoringResult> {
  const rule = ctx.ruleDefinition as { asset_code?: unknown };
  const assetCode = typeof rule.asset_code === 'string' ? rule.asset_code : null;
  if (!assetCode) {
    return {
      kind: 'insufficient_data',
      reason: 'Rule definition missing asset_code',
      details: { indicatorCode: ctx.indicatorCode },
    };
  }

  const asset = await prisma.asset.findUnique({
    where: { code: assetCode },
    select: { id: true, code: true, metadata: true },
  });
  if (!asset) {
    return {
      kind: 'insufficient_data',
      reason: `Asset ${assetCode} not found`,
      details: { indicatorCode: ctx.indicatorCode, assetCode },
    };
  }

  const meta = (asset.metadata ?? {}) as Prisma.JsonObject;
  const contractCode = typeof meta.cotContractCode === 'string' ? meta.cotContractCode : null;
  const traderCategory =
    typeof meta.cotTraderCategory === 'string' ? meta.cotTraderCategory : null;
  if (!contractCode || !traderCategory) {
    return {
      kind: 'insufficient_data',
      reason: 'Asset metadata missing cotContractCode or cotTraderCategory',
      details: { indicatorCode: ctx.indicatorCode, assetCode },
    };
  }

  const cot = await prisma.cotData.findFirst({
    where: {
      contractCode,
      traderCategory,
      isCurrent: true,
      reportDate: { lte: ctx.observationDate },
    },
    orderBy: { reportDate: 'desc' },
  });

  if (!cot) {
    return {
      kind: 'insufficient_data',
      reason: 'No COT data on or before observation date',
      details: { indicatorCode: ctx.indicatorCode, assetCode, contractCode, traderCategory },
    };
  }

  if (cot.longPct === null || cot.weeklyChangePct === null) {
    return {
      kind: 'insufficient_data',
      reason: 'COT row missing longPct or weeklyChangePct',
      details: {
        indicatorCode: ctx.indicatorCode,
        cotDataId: cot.id,
        longPctNull: cot.longPct === null,
        weeklyChangePctNull: cot.weeklyChangePct === null,
      },
    };
  }

  const longPct = Number(cot.longPct);
  const weeklyChangePct = Number(cot.weeklyChangePct);

  const netLabel = classifyNetPositioning(longPct);
  const changeLabel = classifyChangePercent(weeklyChangePct);
  const score = combineCotLabelsForAsset(netLabel, changeLabel) as Score;

  return {
    kind: 'scored',
    score,
    flags: [],
    metadata: {
      assetCode: asset.code,
      contractCode,
      traderCategory,
      netLabel,
      changeLabel,
      longPct,
      weeklyChangePct,
      reportDate: cot.reportDate.toISOString().slice(0, 10),
      cotDataId: cot.id,
    },
  };
}

import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { ScoringResult } from './types';
import { scoreIndicator } from './engine';

export interface ComputeAndStoreParams {
  indicatorCode: string;
  observationDate: Date;
  allowCarryForward?: boolean;
}

export interface ComputeAndStoreResult {
  indicatorCode: string;
  observationDate: string;
  outcome: 'scored' | 'insufficient_data' | 'carry_forward';
  score?: number;
  scoreId?: string;
  flags?: string[];
  metadata?: Record<string, unknown>;
  reason?: string;
}

export async function computeAndStoreScore(
  params: ComputeAndStoreParams,
): Promise<ComputeAndStoreResult> {
  const result: ScoringResult = await scoreIndicator(params);
  const indicator = await prisma.indicator.findUniqueOrThrow({
    where: { code: params.indicatorCode },
  });
  const rule = await prisma.scoringRule.findFirst({
    where: {
      indicatorId: indicator.id,
      effectiveFrom: { lte: params.observationDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: params.observationDate } }],
    },
    orderBy: { version: 'desc' },
  });
  if (!rule) {
    throw new Error('No active rule — engine should have caught this');
  }

  const isoDate = params.observationDate.toISOString().slice(0, 10);

  if (result.kind === 'insufficient_data') {
    logger.info(
      { indicatorCode: params.indicatorCode, observationDate: isoDate, reason: result.reason },
      'Score not written — insufficient data',
    );
    return {
      indicatorCode: params.indicatorCode,
      observationDate: isoDate,
      outcome: 'insufficient_data',
      reason: result.reason,
    };
  }

  const score = result.kind === 'scored' ? result.score : result.score;
  const flags = result.flags;
  const metadata =
    result.kind === 'carry_forward'
      ? {
          ...result.metadata,
          carry_forward: true,
          sourceDate: result.sourceDate,
          daysStale: result.daysStale,
        }
      : result.metadata;

  const dataPointId = (metadata as { dataPointId?: string }).dataPointId;
  if (!dataPointId) {
    const fallback = await prisma.dataPoint.findFirst({
      where: {
        indicatorId: indicator.id,
        isCurrent: true,
        observationDate: { lte: params.observationDate },
      },
      orderBy: { observationDate: 'desc' },
    });
    if (!fallback) {
      logger.warn(
        { indicatorCode: params.indicatorCode },
        'Cannot determine source data_point for score — skipping write',
      );
      return {
        indicatorCode: params.indicatorCode,
        observationDate: isoDate,
        outcome: 'insufficient_data',
        reason: 'No source data_point found for score linkage',
      };
    }
    (metadata as Record<string, unknown>).dataPointId = fallback.id;
  }

  const finalDataPointId = (metadata as { dataPointId: string }).dataPointId;
  const flagStr = flags.length > 0 ? flags.join(',') : null;

  const existing = await prisma.score.findFirst({
    where: {
      indicatorId: indicator.id,
      observationDate: params.observationDate,
      ruleVersionId: rule.id,
    },
  });

  let scoreRow;
  if (existing) {
    if (existing.score === score && existing.flag === flagStr) {
      // Score unchanged; still refresh metadata + computed_at for audit
      const refreshed = await prisma.score.update({
        where: { id: existing.id },
        data: {
          computationMetadata: metadata as Record<string, unknown>,
          computedAt: new Date(),
        },
      });
      logger.info(
        { indicatorCode: params.indicatorCode, observationDate: isoDate, score },
        'Score unchanged — metadata refreshed',
      );
      return {
        indicatorCode: params.indicatorCode,
        observationDate: isoDate,
        outcome: result.kind === 'carry_forward' ? 'carry_forward' : 'scored',
        score,
        scoreId: refreshed.id,
        flags,
        metadata,
      };
    }
    scoreRow = await prisma.score.update({
      where: { id: existing.id },
      data: {
        score,
        flag: flagStr,
        computationMetadata: metadata as Record<string, unknown>,
        computedAt: new Date(),
      },
    });
  } else {
    scoreRow = await prisma.score.create({
      data: {
        indicatorId: indicator.id,
        observationDate: params.observationDate,
        score,
        flag: flagStr,
        ruleVersionId: rule.id,
        dataPointId: finalDataPointId,
        computationMetadata: metadata as Record<string, unknown>,
      },
    });
  }

  return {
    indicatorCode: params.indicatorCode,
    observationDate: isoDate,
    outcome: result.kind === 'carry_forward' ? 'carry_forward' : 'scored',
    score,
    scoreId: scoreRow.id,
    flags,
    metadata,
  };
}

export async function computeAllScoresForDate(
  observationDate: Date,
): Promise<ComputeAndStoreResult[]> {
  const indicators = await prisma.indicator.findMany({
    where: { tool: 'nifty', isActive: true },
    select: { code: true },
    orderBy: { displayOrder: 'asc' },
  });

  const results: ComputeAndStoreResult[] = [];
  for (const ind of indicators) {
    try {
      const r = await computeAndStoreScore({
        indicatorCode: ind.code,
        observationDate,
      });
      results.push(r);
    } catch (err) {
      logger.error({ indicatorCode: ind.code, err }, 'Score compute failed');
      results.push({
        indicatorCode: ind.code,
        observationDate: observationDate.toISOString().slice(0, 10),
        outcome: 'insufficient_data',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

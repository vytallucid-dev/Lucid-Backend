import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { assembleAssetScorecard } from './asset-scorecard.service';

const JOB_NAME = 'edgefinder_scorecard_assembly';

/**
 * Phase 2: the scorecard universe is derived from the asset registry, not a
 * hardcoded list. An asset is in scope when it is active, in EdgeFinder's tool
 * scope, and has at least one asset_indicator_map row.
 *
 * Consequences of those three filters, all intended:
 *  - SPY / NAS100 / US30 are mapped but isActive=false → excluded until Phase 4.
 *  - DXY is active and EdgeFinder-scoped but has no map rows (it is a Compass
 *    input, not a scored asset) → excluded.
 *  - FX pairs have no map rows → excluded; they are the pair orchestrator's job.
 *
 * Ordered by code so job output is stable run to run.
 */
async function resolveScorecardAssetCodes(): Promise<string[]> {
  const assets = await prisma.asset.findMany({
    where: {
      isActive: true,
      toolScope: { has: 'edgefinder' },
      indicatorMaps: { some: {} },
    },
    select: { code: true },
    orderBy: { code: 'asc' },
  });
  return assets.map((a) => a.code);
}

export interface RunScorecardOrchestratorResult {
  logId: string;
  status: 'success' | 'partial' | 'failed';
  assetsSucceeded: string[];
  assetsFailed: Array<{ assetCode: string; error: string }>;
  durationMs: number;
}

function todayUtcDateOnly(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export async function runScorecardOrchestrator(
  triggerType: 'cron' | 'manual',
  triggeredBy?: string | null,
  forDate?: Date,
): Promise<RunScorecardOrchestratorResult> {
  const observationDate = forDate ?? todayUtcDateOnly();
  const dateLabel = observationDate.toISOString().slice(0, 10);
  const startedAt = Date.now();

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType,
    triggeredBy: triggeredBy ?? null,
    metadata: { observationDate: dateLabel },
  });

  const assetsSucceeded: string[] = [];
  const assetsFailed: Array<{ assetCode: string; error: string }> = [];

  const assetCodes = await resolveScorecardAssetCodes();
  logger.info(
    { jobName: JOB_NAME, observationDate: dateLabel, assetCodes },
    'EdgeFinder scorecard universe resolved from registry',
  );

  for (const assetCode of assetCodes) {
    try {
      await assembleAssetScorecard(assetCode, observationDate);
      assetsSucceeded.push(assetCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assetsFailed.push({ assetCode, error: message });
      logger.error(
        { assetCode, observationDate: dateLabel, message },
        'EdgeFinder scorecard assembly failed for asset',
      );
    }
  }

  const status: 'success' | 'partial' | 'failed' =
    assetsFailed.length === 0
      ? 'success'
      : assetsSucceeded.length === 0
        ? 'failed'
        : 'partial';

  const durationMs = Date.now() - startedAt;

  await dataFetchLogRepository.complete({
    logId: log.id,
    status: status === 'failed' ? 'failed' : 'success',
    rowsInserted: assetsSucceeded.length,
    rowsUpdated: 0,
    rowsSkipped: assetsFailed.length,
    errors: assetsFailed.length > 0 ? (assetsFailed as unknown as object) : undefined,
    metadata: {
      observationDate: dateLabel,
      assetsSucceeded,
      assetsFailed,
      durationMs,
    },
  });

  logger.info(
    {
      jobName: JOB_NAME,
      observationDate: dateLabel,
      status,
      succeeded: assetsSucceeded,
      failedCount: assetsFailed.length,
      durationMs,
    },
    'EdgeFinder scorecard orchestrator complete',
  );

  return {
    logId: log.id,
    status,
    assetsSucceeded,
    assetsFailed,
    durationMs,
  };
}

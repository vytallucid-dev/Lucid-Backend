import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { assembleAssetScorecard } from './asset-scorecard.service';

const JOB_NAME = 'edgefinder_scorecard_assembly';

/**
 * Assets in scope for Phase 4+7C. SPY and NAS100 are seeded with
 * isActive=false; pair assets (EURUSD, etc.) are Phase 5.
 */
const ASSET_CODES: ReadonlyArray<string> = ['USD', 'EUR', 'GBP', 'JPY', 'XAUUSD'];

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

  for (const assetCode of ASSET_CODES) {
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

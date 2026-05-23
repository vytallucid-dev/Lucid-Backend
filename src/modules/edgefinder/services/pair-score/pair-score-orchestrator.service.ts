import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { assemblePairScore } from './pair-score.service';
import { PAIR_DEFINITIONS } from './pair-template.config';

const JOB_NAME = 'edgefinder_pair_score_assembly';

const PAIR_CODES: ReadonlyArray<string> = PAIR_DEFINITIONS.map((p) => p.code);

export interface RunPairScoreOrchestratorResult {
  logId: string;
  status: 'success' | 'partial' | 'failed';
  pairsSucceeded: string[];
  pairsFailed: Array<{ pairCode: string; error: string }>;
  durationMs: number;
}

function todayUtcDateOnly(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export async function runPairScoreOrchestrator(
  triggerType: 'cron' | 'manual',
  triggeredBy?: string | null,
  forDate?: Date,
): Promise<RunPairScoreOrchestratorResult> {
  const scoreDate = forDate ?? todayUtcDateOnly();
  const dateLabel = scoreDate.toISOString().slice(0, 10);
  const startedAt = Date.now();

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType,
    triggeredBy: triggeredBy ?? null,
    metadata: { scoreDate: dateLabel },
  });

  const pairsSucceeded: string[] = [];
  const pairsFailed: Array<{ pairCode: string; error: string }> = [];

  for (const pairCode of PAIR_CODES) {
    try {
      await assemblePairScore(pairCode, scoreDate);
      pairsSucceeded.push(pairCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pairsFailed.push({ pairCode, error: message });
      logger.error(
        { pairCode, scoreDate: dateLabel, message },
        'EdgeFinder pair score assembly failed for pair',
      );
    }
  }

  const status: 'success' | 'partial' | 'failed' =
    pairsFailed.length === 0
      ? 'success'
      : pairsSucceeded.length === 0
        ? 'failed'
        : 'partial';

  const durationMs = Date.now() - startedAt;

  await dataFetchLogRepository.complete({
    logId: log.id,
    status: status === 'failed' ? 'failed' : 'success',
    rowsInserted: pairsSucceeded.length,
    rowsUpdated: 0,
    rowsSkipped: pairsFailed.length,
    errors: pairsFailed.length > 0 ? (pairsFailed as unknown as object) : undefined,
    metadata: {
      scoreDate: dateLabel,
      pairsSucceeded,
      pairsFailed,
      durationMs,
    },
  });

  logger.info(
    {
      jobName: JOB_NAME,
      scoreDate: dateLabel,
      status,
      succeeded: pairsSucceeded,
      failedCount: pairsFailed.length,
      durationMs,
    },
    'EdgeFinder pair score orchestrator complete',
  );

  return {
    logId: log.id,
    status,
    pairsSucceeded,
    pairsFailed,
    durationMs,
  };
}

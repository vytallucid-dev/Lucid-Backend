import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { getLatestUsdBaseFundamentals } from '@modules/edgefinder/services/scorecard/scorecard-export.service';

const JOB_NAME = 'nifty_ind9_bridge';
const IND9_CODE = 'IND_NIFTY_09_USD_WEAKNESS';

export interface RunInd9BridgeResult {
  logId: string;
  status: 'success' | 'failed';
  observationDate: Date | null;
  rawSum: number | null;
  usdScorecardDate: Date | null;
  isStaleScorecard: boolean;
  action?: 'inserted' | 'revised' | 'skipped';
  reason?: string;
}

/**
 * Run the NIFTY Ind 9 bridge for a given date (defaults to today UTC).
 *
 * Reads EdgeFinder's USD baseFundamentalsScore (the raw sum of 14 US indicator
 * scores, range -14 to +14) and writes it to data_points.value. The existing
 * manual_raw_composite scoring handler then scores it into +2/+1/0/-1/-2.
 * Idempotent — re-running with unchanged EdgeFinder data produces action='skipped'.
 */
export async function runInd9Bridge(
  triggerType: 'cron' | 'manual',
  triggeredBy?: string | null,
  forDate?: Date,
): Promise<RunInd9BridgeResult> {
  const now = forDate ?? new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType,
    triggeredBy: triggeredBy ?? null,
    targetDateFrom: today,
    targetDateTo: today,
    metadata: { observationDate: today.toISOString().slice(0, 10) },
  });

  const baseResult = {
    status: 'failed' as const,
    observationDate: today,
    rawSum: null,
    usdScorecardDate: null,
    isStaleScorecard: false,
  };

  try {
    const usdData = await getLatestUsdBaseFundamentals(today);

    if (!usdData) {
      logger.error({ observationDate: today }, 'No USD scorecard found — Ind 9 bridge skipped');
      await dataFetchLogRepository.complete({
        logId: log.id,
        status: 'failed',
        metadata: { reason: 'no_usd_scorecard' },
      });
      return { ...baseResult, logId: log.id, reason: 'no_usd_scorecard' };
    }

    if (!usdData.isToday) {
      logger.warn(
        {
          scorecardDate: usdData.observationDate.toISOString().slice(0, 10),
          today: today.toISOString().slice(0, 10),
        },
        'Using stale USD scorecard for Ind 9 bridge',
      );
    }

    const indicator = await prisma.indicator.findUnique({ where: { code: IND9_CODE } });
    if (!indicator) {
      logger.error({ code: IND9_CODE }, 'NIFTY Ind 9 indicator not found in indicators table');
      await dataFetchLogRepository.complete({
        logId: log.id,
        status: 'failed',
        metadata: { reason: 'indicator_not_found' },
      });
      return {
        ...baseResult,
        logId: log.id,
        usdScorecardDate: usdData.observationDate,
        isStaleScorecard: !usdData.isToday,
        rawSum: usdData.baseFundamentalsScore,
        reason: 'indicator_not_found',
      };
    }

    const sourceMetadata = {
      usdScorecardDate: usdData.observationDate.toISOString().slice(0, 10),
      isStaleScorecard: !usdData.isToday,
      indicatorBreakdown: usdData.indicatorBreakdown,
      bridgeVersion: 'v1',
    };

    const upsertResult = await dataPointsRepository.upsert({
      indicatorId: indicator.id,
      observationDate: today,
      value: usdData.baseFundamentalsScore,
      source: 'derived',
      sourceMetadata,
    });

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted: upsertResult.action === 'inserted' ? 1 : 0,
      rowsUpdated: upsertResult.action === 'revised' ? 1 : 0,
      rowsSkipped: upsertResult.action === 'skipped' ? 1 : 0,
    });

    logger.info(
      {
        observationDate: today.toISOString().slice(0, 10),
        rawSum: usdData.baseFundamentalsScore,
        action: upsertResult.action,
        isStaleScorecard: !usdData.isToday,
      },
      'Ind 9 bridge complete',
    );

    return {
      logId: log.id,
      status: 'success',
      observationDate: today,
      rawSum: usdData.baseFundamentalsScore,
      usdScorecardDate: usdData.observationDate,
      isStaleScorecard: !usdData.isToday,
      action: upsertResult.action,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
    };
    logger.error({ ...errorPayload }, 'Ind 9 bridge failed unexpectedly');
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });
    return { ...baseResult, logId: log.id };
  }
}

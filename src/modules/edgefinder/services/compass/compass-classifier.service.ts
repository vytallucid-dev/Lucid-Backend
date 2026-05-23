import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import {
  compassClassificationsRepository,
  type PriorClassificationSnapshot,
} from '@core/repositories/compass-classifications.repository';
import type { ColorBand } from './compass-bands';
import {
  COMPASS_INPUT_WEIGHTS,
  checkCrisisOverride,
  determineCandidateRegime,
  resolveActiveRegime,
  sumVoteWeights,
  type Regime,
} from './compass-classifier-logic';

const JOB_NAME = 'compass_classifier_daily_run';

const EXPECTED_INPUT_CODES = [
  'VIX_5D_AVG',
  'HY_OAS',
  'YIELD_2S10S',
  'DXY_TREND',
  'GOLD_DXY_CORR',
  'US_DATA_STACK',
] as const;

export interface RunClassifierResult {
  logId: string;
  status: 'success' | 'skipped_no_inputs' | 'failed';
  classificationDate: Date | null;
  candidateRegime?: Regime;
  activeRegime?: Regime;
  persistenceDaysCount?: number;
  crisisOverrideFired?: boolean;
  action?: 'inserted' | 'revised' | 'skipped';
  reason?: string;
}

function todayUtcDateOnly(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function decimalToNumber(d: Prisma.Decimal | null): number | null {
  if (d === null) return null;
  return Number(d.toString());
}

/**
 * Run the Compass classifier for a given date (defaults to today UTC).
 *
 * Flow:
 *   1. Start fetch_log row.
 *   2. Fetch all 6 compass_inputs for the date.
 *   3. If fewer than 6 rows present → status 'skipped_no_inputs' (non-trading day or ingest gap).
 *   4. Compute vote weights → crisis check → candidate regime.
 *   5. Look up prior current classification → resolve active regime + persistence.
 *   6. Build voteBreakdown JSON and upsert compass_classifications.
 *   7. Complete fetch_log.
 */
export async function runCompassClassifier(
  triggerType: 'cron' | 'manual',
  triggeredBy?: string | null,
  forDate?: Date,
  isValidation: boolean = false,
): Promise<RunClassifierResult> {
  const classificationDate = forDate ?? todayUtcDateOnly();
  const dateLabel = classificationDate.toISOString().slice(0, 10);

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType,
    triggeredBy: triggeredBy ?? null,
    metadata: { classificationDate: dateLabel, isValidation },
  });

  try {
    const inputs = await prisma.compassInput.findMany({
      where: { observationDate: classificationDate, isValidation },
    });

    if (inputs.length < EXPECTED_INPUT_CODES.length) {
      const presentCodes = inputs.map((r) => r.inputCode).sort();
      logger.info(
        { jobName: JOB_NAME, classificationDate: dateLabel, presentCodes },
        'Compass classifier: not all 6 inputs present — skipping (non-trading day or ingest gap)',
      );
      await dataFetchLogRepository.complete({
        logId: log.id,
        status: 'success',
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 1,
        metadata: {
          classificationDate: dateLabel,
          reason: 'skipped_no_inputs',
          inputsFound: inputs.length,
          inputsExpected: EXPECTED_INPUT_CODES.length,
        },
      });
      return {
        logId: log.id,
        status: 'skipped_no_inputs',
        classificationDate,
        reason: `Only ${inputs.length}/${EXPECTED_INPUT_CODES.length} inputs present for ${dateLabel}`,
      };
    }

    const inputsByCode = new Map(inputs.map((r) => [r.inputCode, r]));

    const inputsWithBand = inputs.map((r) => ({
      inputCode: r.inputCode,
      colorBand: r.colorBand as ColorBand,
    }));
    const voteWeights = sumVoteWeights(inputsWithBand);

    const vixRow = inputsByCode.get('VIX_5D_AVG');
    const hyRow = inputsByCode.get('HY_OAS');
    const crisis = checkCrisisOverride({
      vixFiveDayAvg: vixRow ? decimalToNumber(vixRow.derivedValue) : null,
      hyOasLevel: hyRow ? decimalToNumber(hyRow.rawValue) : null,
    });

    const candidateRegime = determineCandidateRegime({
      voteWeights,
      crisisFired: crisis.fired,
    });

    const prior: PriorClassificationSnapshot | null =
      await compassClassificationsRepository.getMostRecentBefore(
        classificationDate,
        isValidation,
      );

    const { activeRegime, persistenceDaysCount } = resolveActiveRegime({
      candidateRegime,
      crisisFired: crisis.fired,
      prior,
    });

    const voteBreakdown = {
      inputs: Object.fromEntries(
        inputs.map((r) => [
          r.inputCode,
          {
            colorBand: r.colorBand,
            weight: COMPASS_INPUT_WEIGHTS[r.inputCode],
          },
        ]),
      ),
      crisis: {
        fired: crisis.fired,
        vixFiveDayAvg: crisis.vixFiveDayAvg,
        hyOasLevel: crisis.hyOasLevel,
      },
    };

    const upsertResult = await compassClassificationsRepository.upsert({
      classificationDate,
      candidateRegime,
      activeRegime,
      persistenceDaysCount,
      crisisOverrideFired: crisis.fired,
      totalGreenWeight: voteWeights.green,
      totalYellowWeight: voteWeights.yellow,
      totalRedWeight: voteWeights.red,
      voteBreakdown,
      isValidation,
    });

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted: upsertResult.action === 'inserted' ? 1 : 0,
      rowsUpdated: upsertResult.action === 'revised' ? 1 : 0,
      rowsSkipped: upsertResult.action === 'skipped' ? 1 : 0,
      metadata: {
        classificationDate: dateLabel,
        candidateRegime,
        activeRegime,
        persistenceDaysCount,
        crisisOverrideFired: crisis.fired,
        action: upsertResult.action,
      },
    });

    logger.info(
      {
        jobName: JOB_NAME,
        classificationDate: dateLabel,
        candidateRegime,
        activeRegime,
        persistenceDaysCount,
        crisisOverrideFired: crisis.fired,
        action: upsertResult.action,
      },
      'Compass classifier run complete',
    );

    return {
      logId: log.id,
      status: 'success',
      classificationDate,
      candidateRegime,
      activeRegime,
      persistenceDaysCount,
      crisisOverrideFired: crisis.fired,
      action: upsertResult.action,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobName: JOB_NAME, classificationDate: dateLabel, message },
      'Compass classifier run failed',
    );
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      errors: { message },
      metadata: { classificationDate: dateLabel },
    });
    return {
      logId: log.id,
      status: 'failed',
      classificationDate,
      reason: message,
    };
  }
}

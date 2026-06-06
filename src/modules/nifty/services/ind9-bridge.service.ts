import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { Prisma } from '@prisma/client';

const JOB_NAME = 'nifty_ind9_bridge';
const IND9_CODE = 'IND_NIFTY_09_USD_WEAKNESS';
const REQUIRED_INDICATOR_COUNT = 14;
const MIN_PARSEABLE = 12;

// ─────────────────────────────────────────────────────────────────────────────
// Sub-indicator definitions
// ─────────────────────────────────────────────────────────────────────────────

type ScoringCategory =
  | 'absolute_threshold' // Cat A: actual > 50 = +1
  | 'vs_forecast'        // Cat B: actual vs forecast (fallback: vs prior)
  | 'direction_vs_prior' // Cat C: rising = USD strong = +1
  | 'inverted_vs_prior'  // Cat D: rising = USD weak = -1
  | 'sma_direction';     // Cat E: current SMA vs SMA 5 days ago

interface SubIndicatorDef {
  code: string;
  category: ScoringCategory;
}

const SUB_INDICATORS: SubIndicatorDef[] = [
  // Category A — Absolute threshold
  { code: 'US_ISM_MFG',      category: 'absolute_threshold' },
  { code: 'US_ISM_SVC',      category: 'absolute_threshold' },
  // Category B — vs Forecast (fallback prior)
  { code: 'US_GDP_QOQ',      category: 'vs_forecast' },
  { code: 'US_RETAIL_MOM',   category: 'vs_forecast' },
  { code: 'US_CB_CONSCONF',  category: 'vs_forecast' },
  { code: 'US_NFP',          category: 'vs_forecast' },
  { code: 'US_ADP',          category: 'vs_forecast' },
  // Category C — Direction vs Prior (rising = USD strong)
  { code: 'US_CPI_YOY',      category: 'direction_vs_prior' },
  { code: 'US_PPI_MOM',      category: 'direction_vs_prior' },
  { code: 'US_PCE_YOY',      category: 'direction_vs_prior' },
  { code: 'US_JOLTS',        category: 'direction_vs_prior' },
  // Category D — Direction vs Prior INVERTED (rising = USD weak)
  { code: 'US_UNEMP',        category: 'inverted_vs_prior' },
  { code: 'US_JOBLESS_CLAIMS', category: 'inverted_vs_prior' },
  // Category E — SMA direction
  { code: 'US_02Y_SMA',      category: 'sma_direction' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-category scoring functions (all return +1, 0, -1 or null if data missing)
// ─────────────────────────────────────────────────────────────────────────────

function scoreAbsoluteThreshold(actual: number): number {
  if (actual > 50) return 1;
  if (actual < 50) return -1;
  return 0;
}

function scoreVsForecast(actual: number, forecast: number | null, prior: number | null): number | null {
  const baseline = forecast ?? prior;
  if (baseline === null) return null;
  if (actual > baseline) return 1;
  if (actual < baseline) return -1;
  return 0;
}

function scoreDirectionVsPrior(actual: number, prior: number | null): number | null {
  if (prior === null) return null;
  if (actual > prior) return 1;
  if (actual < prior) return -1;
  return 0;
}

function scoreInvertedVsPrior(actual: number, prior: number | null): number | null {
  if (prior === null) return null;
  if (actual > prior) return -1;
  if (actual < prior) return 1;
  return 0;
}

function scoreSmaDirection(currentSma: number, priorSma: number): number {
  if (currentSma > priorSma) return 1;
  if (currentSma < priorSma) return -1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5-tier bucketing (USD-strength raw → NIFTY-facing score)
// Sign flip built in: positive rawComposite = USD strong = bad for NIFTY
// ─────────────────────────────────────────────────────────────────────────────

function bucketToNiftyScore(rawComposite: number): number {
  if (rawComposite <= -7) return 2;
  if (rawComposite <= -4) return 1;
  if (rawComposite <= 3)  return 0;
  if (rawComposite <= 6)  return -1;
  return -2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result interfaces
// ─────────────────────────────────────────────────────────────────────────────

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

interface SubIndicatorResult {
  code: string;
  category: ScoringCategory;
  actual: number | null;
  forecast: number | null;
  prior: number | null;
  score: number | null;
  parseable: boolean;
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the NIFTY Ind 9 bridge for a given date (defaults to today UTC).
 *
 * Decoupled from EdgeFinder scoring. Reads raw data_point values for each of
 * the 14 US sub-indicators directly from the DB and applies a NIFTY-custom
 * scoring matrix (4 categories). Quality gate: ≥12 of 14 must be parseable.
 * Writes the raw composite (range -14 to +14) to data_points.value for
 * IND_NIFTY_09_USD_WEAKNESS. The existing manual_raw_composite handler
 * buckets it to +2/+1/0/-1/-2.
 *
 * Bridge version: v2 (custom NIFTY matrix, decoupled from EdgeFinder scores)
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
    metadata: { observationDate: today.toISOString().slice(0, 10), bridgeVersion: 'v2' },
  });

  const baseResult: Omit<RunInd9BridgeResult, 'logId'> = {
    status: 'failed',
    observationDate: today,
    rawSum: null,
    usdScorecardDate: null,
    isStaleScorecard: false,
  };

  try {
    // ── Step 0: Load all 14 indicator rows from DB ──────────────────────────
    const codes = SUB_INDICATORS.map((s) => s.code);
    const indicators = await prisma.indicator.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    const indicatorIdByCode = new Map(indicators.map((i) => [i.code, i.id]));

    // Fetch the most-recent current data point for each, on or before today
    const dataPoints = await prisma.dataPoint.findMany({
      where: {
        indicatorId: { in: [...indicatorIdByCode.values()] },
        isCurrent: true,
        observationDate: { lte: today },
      },
      orderBy: { observationDate: 'desc' },
      select: {
        indicatorId: true,
        observationDate: true,
        value: true,
        forecastValue: true,
        previousValue: true,
      },
    });

    // Keep only the latest per indicator
    const latestByIndicatorId = new Map<string, (typeof dataPoints)[0]>();
    for (const dp of dataPoints) {
      if (!latestByIndicatorId.has(dp.indicatorId)) {
        latestByIndicatorId.set(dp.indicatorId, dp);
      }
    }

    // ── SMA: also fetch the data point from ≥5 calendar days ago ───────────
    const smaIndicatorId = indicatorIdByCode.get('US_02Y_SMA') ?? null;
    let smaPriorDp: { value: Prisma.Decimal; observationDate: Date } | null = null;

    if (smaIndicatorId) {
      const currentSmaDp = latestByIndicatorId.get(smaIndicatorId);
      if (currentSmaDp) {
        const cutoff = new Date(currentSmaDp.observationDate);
        cutoff.setUTCDate(cutoff.getUTCDate() - 5);

        smaPriorDp = await prisma.dataPoint.findFirst({
          where: {
            indicatorId: smaIndicatorId,
            isCurrent: true,
            observationDate: { lte: cutoff },
          },
          orderBy: { observationDate: 'desc' },
          select: { value: true, observationDate: true },
        });
      }
    }

    // ── Step 1 & 2: Score each sub-indicator ────────────────────────────────
    const results: SubIndicatorResult[] = [];

    for (const def of SUB_INDICATORS) {
      const indicatorId = indicatorIdByCode.get(def.code);
      if (!indicatorId) {
        results.push({ ...def, actual: null, forecast: null, prior: null, score: null, parseable: false, note: 'indicator_not_in_db' });
        continue;
      }

      const dp = latestByIndicatorId.get(indicatorId) ?? null;
      if (!dp) {
        results.push({ ...def, actual: null, forecast: null, prior: null, score: null, parseable: false, note: 'no_data_point' });
        continue;
      }

      const actual = Number(dp.value);
      const forecast = dp.forecastValue !== null ? Number(dp.forecastValue) : null;
      const prior = dp.previousValue !== null ? Number(dp.previousValue) : null;

      if (!Number.isFinite(actual)) {
        results.push({ ...def, actual: null, forecast, prior, score: null, parseable: false, note: 'non_finite_actual' });
        continue;
      }

      let score: number | null = null;
      let note: string | undefined;

      switch (def.category) {
        case 'absolute_threshold':
          score = scoreAbsoluteThreshold(actual);
          break;

        case 'vs_forecast': {
          score = scoreVsForecast(actual, forecast, prior);
          if (score === null) note = 'no_forecast_or_prior';
          else if (forecast === null) note = 'used_prior_as_baseline';
          break;
        }

        case 'direction_vs_prior': {
          score = scoreDirectionVsPrior(actual, prior);
          if (score === null) note = 'no_prior';
          break;
        }

        case 'inverted_vs_prior': {
          score = scoreInvertedVsPrior(actual, prior);
          if (score === null) note = 'no_prior';
          break;
        }

        case 'sma_direction': {
          if (smaPriorDp === null) {
            note = 'no_sma_prior_5d';
          } else {
            const currentSma = actual;
            const priorSma = Number(smaPriorDp.value);
            if (!Number.isFinite(priorSma)) {
              note = 'non_finite_prior_sma';
            } else {
              score = scoreSmaDirection(currentSma, priorSma);
              note = `prior_sma_date:${smaPriorDp.observationDate.toISOString().slice(0, 10)}`;
            }
          }
          break;
        }
      }

      results.push({ ...def, actual, forecast, prior, score, parseable: score !== null, note });
    }

    // ── Step 1: Quality gate ─────────────────────────────────────────────────
    const parseableCount = results.filter((r) => r.parseable).length;

    if (parseableCount < MIN_PARSEABLE) {
      logger.warn(
        {
          parseableCount,
          required: MIN_PARSEABLE,
          total: REQUIRED_INDICATOR_COUNT,
          observationDate: today.toISOString().slice(0, 10),
          missing: results.filter((r) => !r.parseable).map((r) => r.code),
        },
        'Ind 9 bridge: insufficient parseable sub-indicators — suppressing score',
      );
      await dataFetchLogRepository.complete({
        logId: log.id,
        status: 'failed',
        metadata: { reason: 'insufficient_data', parseableCount, required: MIN_PARSEABLE },
      });
      return { ...baseResult, logId: log.id, reason: 'insufficient_data' };
    }

    // ── Step 3: Sum the raw composite ────────────────────────────────────────
    const rawComposite = results.reduce((sum, r) => sum + (r.score ?? 0), 0);

    // ── Step 4: Bucket to NIFTY-facing score (for metadata / logging) ────────
    const niftyScore = bucketToNiftyScore(rawComposite);

    // ── Persist ──────────────────────────────────────────────────────────────
    const ind9Indicator = await prisma.indicator.findUnique({ where: { code: IND9_CODE } });
    if (!ind9Indicator) {
      logger.error({ code: IND9_CODE }, 'NIFTY Ind 9 indicator not found in indicators table');
      await dataFetchLogRepository.complete({
        logId: log.id,
        status: 'failed',
        metadata: { reason: 'indicator_not_found' },
      });
      return { ...baseResult, logId: log.id, reason: 'indicator_not_found' };
    }

    const sourceMetadata: Record<string, unknown> = {
      bridgeVersion: 'v2',
      observationDate: today.toISOString().slice(0, 10),
      rawComposite,
      niftyScore,
      parseableCount,
      totalRequired: REQUIRED_INDICATOR_COUNT,
      subIndicators: results.map((r) => ({
        code: r.code,
        category: r.category,
        actual: r.actual,
        forecast: r.forecast,
        prior: r.prior,
        score: r.score,
        parseable: r.parseable,
        ...(r.note ? { note: r.note } : {}),
      })),
    };

    const upsertResult = await dataPointsRepository.upsert({
      indicatorId: ind9Indicator.id,
      observationDate: today,
      value: rawComposite,
      source: 'derived',
      sourceMetadata: sourceMetadata as Prisma.InputJsonObject,
    });

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted: upsertResult.action === 'inserted' ? 1 : 0,
      rowsUpdated: upsertResult.action === 'revised' ? 1 : 0,
      rowsSkipped: upsertResult.action === 'skipped' ? 1 : 0,
      metadata: {
        rawComposite,
        niftyScore,
        parseableCount,
        action: upsertResult.action,
      },
    });

    logger.info(
      {
        observationDate: today.toISOString().slice(0, 10),
        rawComposite,
        niftyScore,
        parseableCount,
        action: upsertResult.action,
      },
      'Ind 9 bridge v2 complete',
    );

    return {
      logId: log.id,
      status: 'success',
      observationDate: today,
      rawSum: rawComposite,
      usdScorecardDate: today,
      isStaleScorecard: false,
      action: upsertResult.action,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    logger.error({ ...errorPayload }, 'Ind 9 bridge v2 failed unexpectedly');
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });
    return { ...baseResult, logId: log.id };
  }
}


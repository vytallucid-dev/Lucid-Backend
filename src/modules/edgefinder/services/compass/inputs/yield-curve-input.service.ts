import { logger } from '@core/utils/logger';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { prisma } from '@core/db/prisma';
import { compassCurveStateRepository } from '@core/repositories/compass-curve-state.repository';
import { evaluate2s10s, type ColorBand } from '../compass-bands';
import {
  scanForMostRecentEpisode,
  isWithinRedWindow,
  type CurveObservation,
} from '../compass-curve-state-machine';
import type { CompassConfigDefinition } from '../compass-config.types';
import { addDays } from './_input-helpers';
import { buildCleanSeries, obsChangeFromClean, type DatedValue } from '../compass-staleness';
import { generateTradingDays } from '../validation/historical-backfill.service';

const INPUT_CODE = 'YIELD_2S10S';
const DELTA30_LOOKBACK_OBS = 30;
const MIN_CLEAN_OBS_NEEDED = DELTA30_LOOKBACK_OBS + 1;

// Bootstrap lookback for the inversion-episode scan. Needs to reliably reach
// back past the most recent un-inversion event plus its 60-trading-day red
// window and the 5/10-obs confirmation runs. US 10y-2y inversion episodes
// have historically run many months (e.g. 2022-2024); 730 calendar days
// (~2 years) comfortably covers any realistic episode boundary in one single
// sequential FRED call (fetchSeries takes one `daysBack` — no pagination, so
// this is still exactly one HTTP request regardless of window size).
const EPISODE_SCAN_DAYS_BACK = 730;

/**
 * Read the Jobs sub-check colour band that US_DATA_STACK computed for the
 * SAME observationDate. The curve input depends on this (Problem 1) rather
 * than relying on orchestrator ordering: it reads the already-persisted
 * compass_inputs row for US_DATA_STACK, which is deterministic regardless of
 * list order. If that row or its subChecks.jobs.band is missing, this throws
 * rather than silently defaulting — the curve must never score against a
 * stale or absent jobs sub-check.
 */
async function getJobsSubCheckBand(
  observationDate: Date,
  isValidation: boolean,
): Promise<ColorBand> {
  const row = await prisma.compassInput.findUnique({
    where: {
      observationDate_inputCode_isValidation: {
        observationDate,
        inputCode: 'US_DATA_STACK',
        isValidation,
      },
    },
  });

  if (!row) {
    throw new Error(
      `YIELD_2S10S: US_DATA_STACK compass_inputs row missing for ${observationDate.toISOString().slice(0, 10)} — cannot resolve jobs sub-check`,
    );
  }

  const subChecks = row.subChecks as { jobs?: { band?: unknown } } | null;
  const jobsBand = subChecks?.jobs?.band;
  if (jobsBand !== 'GREEN' && jobsBand !== 'YELLOW' && jobsBand !== 'RED') {
    throw new Error(
      `YIELD_2S10S: US_DATA_STACK subChecks.jobs.band missing/invalid for ${observationDate.toISOString().slice(0, 10)} (got ${JSON.stringify(jobsBand)})`,
    );
  }

  return jobsBand;
}

export async function ingestYieldCurveInput(
  observationDate: Date,
  config: CompassConfigDefinition,
  isValidation: boolean = false,
): Promise<void> {
  // Single sequential fetch — 730 days back in one call, used BOTH for the
  // delta30 calc and the episode scan, so the curve input never makes more
  // than one T10Y2Y request per run (keeps FRED happy per the existing
  // sequential-fetch convention in us-data-stack-input.service.ts).
  const obs = isValidation
    ? await compassFredClient.fetchSeriesByDateRange(
        compassFredClient.SERIES.YIELD_2S10S,
        addDays(observationDate, -EPISODE_SCAN_DAYS_BACK),
        observationDate,
      )
    : await compassFredClient.fetchSeries(
        compassFredClient.SERIES.YIELD_2S10S,
        EPISODE_SCAN_DAYS_BACK,
      );

  const windowed = isValidation
    ? obs.filter((o) => o.date.getTime() <= observationDate.getTime())
    : obs;

  const observations: CurveObservation[] = windowed
    .filter((o): o is { date: Date; value: number } => o.value !== null)
    .map((o) => ({ date: o.date, value: o.value }));

  if (observations.length === 0) {
    throw new Error('YIELD_2S10S: FRED returned zero usable values');
  }

  // Phase 5: delta30 is computed off an observation-indexed, forward-filled
  // clean series (reference calendar = FRED's own weekday business-day
  // range) rather than raw index math over the null-filtered series — a gap
  // no longer silently shifts which date "30 observations back" lands on.
  // The episode/red-window scan below is UNCHANGED (still fed the raw
  // null-filtered `observations`) — that state machine's algorithm is out of
  // scope for this phase.
  const todayLevel = observations[observations.length - 1].value;
  const windowStart = windowed[0].date;
  const referenceCalendar = generateTradingDays(windowStart, observationDate);
  const rawSeries: DatedValue[] = observations;
  const clean = buildCleanSeries(
    rawSeries,
    referenceCalendar,
    observationDate,
    config.staleness.stale_limit_fred_rates_days,
  );
  const insufficientHistory = clean.series.length < MIN_CLEAN_OBS_NEEDED;
  const delta30 =
    insufficientHistory || clean.isStale ? null : obsChangeFromClean(clean.series, DELTA30_LOOKBACK_OBS);

  const { mostRecentEpisode } = scanForMostRecentEpisode(
    observations,
    config.yieldCurve.curve_inversion_min_obs,
    config.yieldCurve.curve_uninversion_min_obs,
  );

  const insideRedWindow =
    mostRecentEpisode?.unInversionDate != null &&
    isWithinRedWindow(
      observations,
      mostRecentEpisode.unInversionDate,
      observationDate,
      config.yieldCurve.curve_red_window_days,
    );

  await compassCurveStateRepository.upsert({
    computedForDate: observationDate,
    inversionStart: mostRecentEpisode?.inversionStart ?? null,
    unInversionDate: mostRecentEpisode?.unInversionDate ?? null,
    isValidation,
  });

  const jobsSubCheckBand = await getJobsSubCheckBand(observationDate, isValidation);

  const colorBand = evaluate2s10s(todayLevel, delta30, insideRedWindow, jobsSubCheckBand, config);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: todayLevel,
    derivedValue: delta30,
    colorBand,
    subChecks: {
      observationCount: observations.length,
      seriesId: compassFredClient.SERIES.YIELD_2S10S,
      inversionStart: mostRecentEpisode?.inversionStart?.toISOString().slice(0, 10) ?? null,
      unInversionDate: mostRecentEpisode?.unInversionDate?.toISOString().slice(0, 10) ?? null,
      insideRedWindow,
      jobsSubCheckBand,
      insufficientHistory,
      cleanObservationCount: clean.series.length,
      stale: clean.isStale,
      staleTradingDays: clean.staleTradingDays,
      staleLimitDays: config.staleness.stale_limit_fred_rates_days,
    },
    source: 'fred',
    isValidation,
  });

  logger.info(
    {
      inputCode: INPUT_CODE,
      todayLevel,
      delta30,
      insideRedWindow,
      jobsSubCheckBand,
      inversionStart: mostRecentEpisode?.inversionStart ?? null,
      unInversionDate: mostRecentEpisode?.unInversionDate ?? null,
      colorBand,
      isValidation,
    },
    'Compass: 2s10s yield curve input ingested',
  );
}

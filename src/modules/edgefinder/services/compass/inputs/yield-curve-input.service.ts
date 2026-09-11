import { logger } from '@core/utils/logger';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { prisma } from '@core/db/prisma';
import { compassCurveStateRepository } from '@core/repositories/compass-curve-state.repository';
import { evaluate2s10s, curveGreenBlockedByRealShock, type ColorBand } from '../compass-bands';
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

/**
 * Read the R1_REAL_YIELD_SHOCK band that was persisted for the SAME
 * observationDate, for the Phase C GREEN gate.
 *
 * Unlike the jobs sub-check above, a missing or null band here is NOT an error
 * and must NOT throw. R1 is legitimately unavailable in three ordinary cases:
 * before DFII10 begins on 2003-01-02, when the series is stale or too short,
 * and under any config version that predates the `yields` block. In all three
 * the gate is simply inert and the curve behaves exactly as it did before.
 *
 * FAILING OPEN IS THE CORRECT DIRECTION HERE. A null band cannot block the GREEN
 * clause, so missing R1 data can never manufacture a more negative reading than
 * the evidence supports — it just forgoes the correction.
 */
async function getRealYieldShockBand(
  observationDate: Date,
  isValidation: boolean,
): Promise<ColorBand | null> {
  const row = await prisma.compassInput.findUnique({
    where: {
      observationDate_inputCode_isValidation: {
        observationDate,
        inputCode: 'REAL_YIELD_SHOCK',
        isValidation,
      },
    },
  });
  if (!row) return null;
  const subChecks = row.subChecks as { band?: unknown } | null;
  const band = subChecks?.band;
  return band === 'GREEN' || band === 'YELLOW' || band === 'RED' ? band : null;
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
  const realYieldShockBand = await getRealYieldShockBand(observationDate, isValidation);

  const colorBand = evaluate2s10s(
    todayLevel,
    delta30,
    insideRedWindow,
    jobsSubCheckBand,
    config,
    realYieldShockBand,
  );
  // Phase C audit: record whether the GREEN clause was actually suppressed, so
  // the effect is countable after the fact rather than inferred.
  const curveGreenGated =
    curveGreenBlockedByRealShock(config, realYieldShockBand) &&
    todayLevel >= 0 &&
    delta30 !== null &&
    delta30 >= config.yieldCurve.curve_delta30_floor;

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
      realYieldShockBand,
      curveGreenGated,
      insufficientHistory,
      cleanObservationCount: clean.series.length,
      stale: clean.isStale,
      staleTradingDays: clean.staleTradingDays,
      staleLimitDays: config.staleness.stale_limit_fred_rates_days,
    },
    source: 'fred',
    configVersionLabel: config.versionLabel,
    isValidation,
  });

  logger.info(
    {
      inputCode: INPUT_CODE,
      todayLevel,
      delta30,
      insideRedWindow,
      jobsSubCheckBand,
      realYieldShockBand,
      curveGreenGated,
      inversionStart: mostRecentEpisode?.inversionStart ?? null,
      unInversionDate: mostRecentEpisode?.unInversionDate ?? null,
      colorBand,
      isValidation,
    },
    'Compass: 2s10s yield curve input ingested',
  );
}

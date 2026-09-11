import { logger } from '@core/utils/logger';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { evaluateRealYieldShock } from '../compass-bands';
import type { CompassConfigDefinition } from '../compass-config.types';
import { addDays } from './_input-helpers';
import { buildCleanSeries, obsChangeFromClean, type DatedValue } from '../compass-staleness';
import { generateTradingDays } from '../validation/historical-backfill.service';

/**
 * R1_REAL_YIELD_SHOCK — the 60-observation change in the 10-year TIPS real
 * yield (FRED `DFII10`), in basis points.
 *
 * NON-VOTING IN THIS PHASE. It is deliberately absent from both
 * `EXPECTED_INPUT_CODES` and `config.weights`:
 *
 *   - `sumVoteWeights` throws on any input code missing from config.weights, and
 *   - `resolveForDate` throws for EVERY caller if the weights do not sum to
 *     exactly 8.0,
 *
 * so adding it at its proposed weight of 1.5 is not a one-line change: it moves
 * the scale to 9.5 while `redRiskOffAt` (3.5) and `greenRiskOnAt` (5.0) stay
 * calibrated for 8.0, silently loosening both by ~16%. Whether it should vote is
 * settled by the rescaling report, not here.
 *
 * It is not inert, though. The 2s10s GREEN clause is gated on it (see
 * `evaluate2s10s`), so this row must be written BEFORE `YIELD_2S10S` runs — the
 * same ordering dependency `US_DATA_STACK` already has.
 *
 * WHY THIS RULE AND NOT A TERM-PREMIUM RULE. It explains gold at R² 0.214
 * in-sample (pre-2015) and 0.214 out-of-sample (2015+), with identical signs on
 * all five assets tested and a sensitivity curve that is monotone across the
 * whole 0-110bp range in both halves independently. Term premium, by contrast,
 * is not a well-defined observable: ACM and Kim-Wright disagree on the
 * term-premium share of April 2025 by 1.22 and on the sign of the current
 * regime, so any absolute threshold inherits that disagreement.
 *
 * COVERAGE. `DFII10` starts 2003-01-02. Before that this input cannot be
 * computed at all, the band is null, and the curve gate is therefore inert. The
 * 2008 window is covered; nothing earlier is.
 *
 * ONE-SIDED BY DESIGN. Only fast RISES are banded. A symmetric negative leg was
 * never tested and must not be added without its own evidence.
 */

const INPUT_CODE = 'REAL_YIELD_SHOCK';
const CHANGE_LOOKBACK_OBS = 60;
/**
 * 60 trading observations is ~84 calendar days. 120 gives real margin: the
 * worst 120-day window in the DFII10 era yields 78 trading days against the 61
 * needed, so the lookback never runs short even across a holiday-dense stretch.
 */
const DAYS_BACK = 120;
const MIN_CLEAN_OBS_NEEDED = CHANGE_LOOKBACK_OBS + 1;

export async function ingestRealYieldShockInput(
  observationDate: Date,
  config: CompassConfigDefinition,
  isValidation: boolean = false,
): Promise<void> {
  const obs = isValidation
    ? await compassFredClient.fetchSeriesByDateRange(
        compassFredClient.SERIES.REAL_YIELD_10Y,
        addDays(observationDate, -DAYS_BACK),
        observationDate,
      )
    : await compassFredClient.fetchSeries(compassFredClient.SERIES.REAL_YIELD_10Y, DAYS_BACK);

  const windowed = isValidation
    ? obs.filter((o) => o.date.getTime() <= observationDate.getTime())
    : obs;

  const rawSeries: DatedValue[] = windowed
    .filter((o): o is { date: Date; value: number } => o.value !== null)
    .map((o) => ({ date: o.date, value: o.value }));

  // Before 2003-01-02 DFII10 simply does not exist. That is a legitimate,
  // expected state for any historical replay, NOT an error — unlike the other
  // FRED inputs this one must never throw on an empty series, or it would take
  // the whole classifier down for every pre-2003 date.
  if (rawSeries.length === 0) {
    await compassInputsRepository.upsert({
      observationDate,
      inputCode: INPUT_CODE,
      rawValue: null,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: {
        seriesUnavailable: true,
        reason: 'DFII10 has no observations in this window (series begins 2003-01-02)',
        seriesId: compassFredClient.SERIES.REAL_YIELD_10Y,
        band: null,
        stale: false,
      },
      source: 'fred',
      configVersionLabel: config.versionLabel,
      isValidation,
    });
    logger.info(
      { inputCode: INPUT_CODE, isValidation },
      'Compass: DFII10 unavailable for this date — R1 not computed (expected before 2003)',
    );
    return;
  }

  const referenceCalendar = generateTradingDays(windowed[0].date, observationDate);
  const clean = buildCleanSeries(
    rawSeries,
    referenceCalendar,
    observationDate,
    config.staleness.stale_limit_fred_rates_days,
  );

  const todayLevel = rawSeries[rawSeries.length - 1].value;
  const insufficientHistory = clean.series.length < MIN_CLEAN_OBS_NEEDED;

  if (insufficientHistory || clean.isStale) {
    await compassInputsRepository.upsert({
      observationDate,
      inputCode: INPUT_CODE,
      rawValue: todayLevel,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: {
        insufficientHistory,
        stale: clean.isStale,
        staleTradingDays: clean.staleTradingDays,
        staleLimitDays: config.staleness.stale_limit_fred_rates_days,
        latestRealDate: clean.latestRealDate?.toISOString().slice(0, 10) ?? null,
        cleanObservationCount: clean.series.length,
        neededObservationCount: MIN_CLEAN_OBS_NEEDED,
        seriesId: compassFredClient.SERIES.REAL_YIELD_10Y,
        band: null,
      },
      source: 'fred',
      configVersionLabel: config.versionLabel,
      isValidation,
    });
    logger.warn(
      {
        inputCode: INPUT_CODE,
        insufficientHistory,
        stale: clean.isStale,
        cleanCount: clean.series.length,
        isValidation,
      },
      'Compass: R1 real-yield shock could not be computed — flagged, band null',
    );
    return;
  }

  // Percentage points -> basis points. DFII10 is quoted in percent.
  const changePp = obsChangeFromClean(clean.series, CHANGE_LOOKBACK_OBS);
  const change60dBp = changePp === null ? null : changePp * 100;
  const band = evaluateRealYieldShock(change60dBp, config);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: clean.series[clean.series.length - 1].value,
    derivedValue: change60dBp,
    // The stored colorBand is YELLOW-as-placeholder when the band is null so the
    // NOT NULL column is satisfied; `subChecks.band` is the authoritative value
    // and is what the curve gate and the UI read. This input does not vote, so
    // the placeholder never reaches a vote tally.
    colorBand: band ?? 'YELLOW',
    subChecks: {
      band,
      voting: false,
      change60dBp,
      lookbackObs: CHANGE_LOOKBACK_OBS,
      redAtBp: config.yields?.real_yield_shock_60d_red_bp ?? null,
      yellowAtBp: config.yields?.real_yield_shock_60d_yellow_bp ?? null,
      observationCount: clean.series.length,
      seriesId: compassFredClient.SERIES.REAL_YIELD_10Y,
      stale: false,
    },
    source: 'fred',
    configVersionLabel: config.versionLabel,
    isValidation,
  });

  logger.info(
    { inputCode: INPUT_CODE, todayLevel, change60dBp, band, voting: false, isValidation },
    'Compass: R1 real-yield shock ingested (shadow, non-voting)',
  );
}

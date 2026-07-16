import { logger } from '@core/utils/logger';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { evaluateHyOas } from '../compass-bands';
import type { CompassConfigDefinition } from '../compass-config.types';
import { addDays } from './_input-helpers';
import { buildCleanSeries, obsChangeFromClean, type DatedValue } from '../compass-staleness';
import { generateTradingDays } from '../validation/historical-backfill.service';

const INPUT_CODE = 'HY_OAS';
const DAYS_BACK = 50;
const DELTA_LOOKBACK_OBS = 10;
// DELTA_LOOKBACK_OBS clean observations + margin for the forward-fill window
// itself to have enough real data behind it.
const MIN_CLEAN_OBS_NEEDED = DELTA_LOOKBACK_OBS + 1;

/**
 * Phase 5: "trading day" reference calendar for a FRED series is its own
 * weekday range (Mon-Fri) over the fetched window — FRED rate series already
 * publish business-days-only, so a weekday filter (already precedented by
 * historical-backfill.service.ts's generateTradingDays) reconstructs which
 * dates SHOULD have an observation. A missing weekday inside that range is a
 * real gap (holiday or genuine feed staleness); this module cannot tell
 * those apart, which is why fills only ever apply within the configured
 * staleness limit — see compass-staleness.ts's documented failure mode.
 */
export async function ingestHyOasInput(
  observationDate: Date,
  config: CompassConfigDefinition,
  isValidation: boolean = false,
): Promise<void> {
  const obs = isValidation
    ? await compassFredClient.fetchSeriesByDateRange(
        compassFredClient.SERIES.HY_OAS,
        addDays(observationDate, -DAYS_BACK),
        observationDate,
      )
    : await compassFredClient.fetchSeries(
        compassFredClient.SERIES.HY_OAS,
        DAYS_BACK,
      );

  const windowed = isValidation
    ? obs.filter((o) => o.date.getTime() <= observationDate.getTime())
    : obs;

  const rawSeries: DatedValue[] = windowed
    .filter((o): o is { date: Date; value: number } => o.value !== null)
    .map((o) => ({ date: o.date, value: o.value }));

  if (rawSeries.length === 0) {
    throw new Error('HY_OAS: FRED returned zero usable values');
  }

  const windowStart = windowed[0].date;
  const referenceCalendar = generateTradingDays(windowStart, observationDate);

  const clean = buildCleanSeries(
    rawSeries,
    referenceCalendar,
    observationDate,
    config.staleness.stale_limit_fred_rates_days,
  );

  if (clean.series.length < MIN_CLEAN_OBS_NEEDED) {
    await compassInputsRepository.upsert({
      observationDate,
      inputCode: INPUT_CODE,
      rawValue: rawSeries[rawSeries.length - 1].value,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: {
        insufficientHistory: true,
        cleanObservationCount: clean.series.length,
        neededObservationCount: MIN_CLEAN_OBS_NEEDED,
        seriesId: compassFredClient.SERIES.HY_OAS,
      },
      source: 'fred',
      isValidation,
    });
    logger.warn(
      { inputCode: INPUT_CODE, cleanCount: clean.series.length, isValidation },
      'Compass: HY OAS insufficient clean history for delta10 — YELLOW + flagged',
    );
    return;
  }

  if (clean.isStale) {
    await compassInputsRepository.upsert({
      observationDate,
      inputCode: INPUT_CODE,
      rawValue: rawSeries[rawSeries.length - 1].value,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: {
        stale: true,
        staleTradingDays: clean.staleTradingDays,
        staleLimitDays: config.staleness.stale_limit_fred_rates_days,
        latestRealDate: clean.latestRealDate?.toISOString().slice(0, 10) ?? null,
        seriesId: compassFredClient.SERIES.HY_OAS,
      },
      source: 'fred',
      isValidation,
    });
    logger.warn(
      { inputCode: INPUT_CODE, staleTradingDays: clean.staleTradingDays, isValidation },
      'Compass: HY OAS stale beyond limit — YELLOW + flagged',
    );
    return;
  }

  const todayLevel = clean.series[clean.series.length - 1].value;
  const delta10 = obsChangeFromClean(clean.series, DELTA_LOOKBACK_OBS);
  const colorBand = evaluateHyOas(todayLevel, delta10, config);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: todayLevel,
    derivedValue: delta10,
    colorBand,
    subChecks: {
      observationCount: clean.series.length,
      seriesId: compassFredClient.SERIES.HY_OAS,
      stale: false,
    },
    source: 'fred',
    isValidation,
  });

  logger.info(
    { inputCode: INPUT_CODE, todayLevel, delta10, colorBand, isValidation },
    'Compass: HY OAS input ingested',
  );
}

import { logger } from '@core/utils/logger';
import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { evaluateDxyTrend } from '../compass-bands';
import type { CompassConfigDefinition } from '../compass-config.types';
import { addDays, toIsoDate } from './_input-helpers';
import { buildCleanSeries, obsChangeFromClean, smaFromClean, type DatedValue } from '../compass-staleness';
import { generateTradingDays } from '../validation/historical-backfill.service';

const INPUT_CODE = 'DXY_TREND';
const SYMBOL = 'DXY.INDX';
const DAYS_BACK = 90;
const MOVE_LOOKBACK_OBS = 5;
const SMA_LOOKBACK_OBS = 50;
const MIN_CLEAN_OBS_NEEDED = SMA_LOOKBACK_OBS; // the larger of the two lookbacks (+1 not needed: SMA uses the last N inclusive)

export async function ingestDxyTrendInput(
  observationDate: Date,
  config: CompassConfigDefinition,
  isValidation: boolean = false,
): Promise<void> {
  // EODHD's standard EOD endpoint takes a `from` but no end date; the validation
  // upper bound is enforced by the post-fetch `date <= observationDate` filter.
  const fromIso = toIsoDate(
    isValidation ? addDays(observationDate, -DAYS_BACK) : addDays(new Date(), -DAYS_BACK),
  );

  const rows = await eodhdClient.fetchEodSeries(SYMBOL, fromIso);

  const obsIso = toIsoDate(observationDate);
  const windowed = isValidation ? rows.filter((p) => p.date <= obsIso) : rows;

  if (windowed.length === 0) {
    throw new Error('DXY_TREND: EODHD returned zero rows');
  }

  const rawSeries: DatedValue[] = windowed.map((p) => ({
    date: new Date(`${p.date}T00:00:00.000Z`),
    value: p.value,
  }));
  const windowStart = rawSeries[0].date;
  const referenceCalendar = generateTradingDays(windowStart, observationDate);

  const clean = buildCleanSeries(
    rawSeries,
    referenceCalendar,
    observationDate,
    config.staleness.stale_limit_market_data_days,
  );

  const todayClose = rawSeries[rawSeries.length - 1].value;

  if (clean.series.length < MIN_CLEAN_OBS_NEEDED) {
    await compassInputsRepository.upsert({
      observationDate,
      inputCode: INPUT_CODE,
      rawValue: todayClose,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: {
        insufficientHistory: true,
        cleanObservationCount: clean.series.length,
        neededObservationCount: MIN_CLEAN_OBS_NEEDED,
        symbol: SYMBOL,
      },
      source: 'eodhd',
      isValidation,
    });
    logger.warn(
      { inputCode: INPUT_CODE, cleanCount: clean.series.length, isValidation },
      'Compass: DXY insufficient clean history for sma50/move5 — YELLOW + flagged',
    );
    return;
  }

  if (clean.isStale) {
    await compassInputsRepository.upsert({
      observationDate,
      inputCode: INPUT_CODE,
      rawValue: todayClose,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: {
        stale: true,
        staleTradingDays: clean.staleTradingDays,
        staleLimitDays: config.staleness.stale_limit_market_data_days,
        latestRealDate: clean.latestRealDate?.toISOString().slice(0, 10) ?? null,
        symbol: SYMBOL,
      },
      source: 'eodhd',
      isValidation,
    });
    logger.warn(
      { inputCode: INPUT_CODE, staleTradingDays: clean.staleTradingDays, isValidation },
      'Compass: DXY stale beyond limit — YELLOW + flagged',
    );
    return;
  }

  const cleanToday = clean.series[clean.series.length - 1].value;
  const sma50 = smaFromClean(clean.series, SMA_LOOKBACK_OBS);
  const move5Change = obsChangeFromClean(clean.series, MOVE_LOOKBACK_OBS);

  if (sma50 === null || move5Change === null) {
    throw new Error(
      `DXY_TREND: insufficient clean history (got ${clean.series.length}, need ${SMA_LOOKBACK_OBS} + ${MOVE_LOOKBACK_OBS})`,
    );
  }

  const dev = Math.abs(cleanToday / sma50 - 1);
  const closeAtLookback = clean.series[clean.series.length - 1 - MOVE_LOOKBACK_OBS].value;
  const move5 = Math.abs(cleanToday / closeAtLookback - 1);
  const colorBand = evaluateDxyTrend(dev, move5, config);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: cleanToday,
    derivedValue: dev,
    colorBand,
    subChecks: {
      sma50,
      move5,
      symbol: SYMBOL,
      stale: false,
    },
    source: 'eodhd',
    isValidation,
  });

  logger.info(
    {
      inputCode: INPUT_CODE,
      todayClose: cleanToday,
      sma50,
      dev,
      move5,
      colorBand,
      isValidation,
    },
    'Compass: DXY trend input ingested',
  );
}

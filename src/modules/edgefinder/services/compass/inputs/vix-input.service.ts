import { logger } from '@core/utils/logger';
import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { evaluateVix } from '../compass-bands';
import type { CompassConfigDefinition } from '../compass-config.types';
import { addDays, toIsoDate } from './_input-helpers';
import { buildCleanSeries, smaFromClean, type DatedValue } from '../compass-staleness';
import { generateTradingDays } from '../validation/historical-backfill.service';

const INPUT_CODE = 'VIX_5D_AVG';
const SYMBOL = 'VIX.INDX';
const DAYS_BACK = 15;
const AVG_LOOKBACK_OBS = 5;

export async function ingestVixInput(
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
    throw new Error('VIX_5D_AVG: EODHD returned zero rows');
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

  if (clean.series.length < AVG_LOOKBACK_OBS) {
    await compassInputsRepository.upsert({
      observationDate,
      inputCode: INPUT_CODE,
      rawValue: todayClose,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: {
        insufficientHistory: true,
        cleanObservationCount: clean.series.length,
        neededObservationCount: AVG_LOOKBACK_OBS,
      },
      source: 'eodhd',
      isValidation,
    });
    logger.warn(
      { inputCode: INPUT_CODE, cleanCount: clean.series.length, isValidation },
      'Compass: VIX insufficient clean history for 5-day avg — YELLOW + flagged',
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
      },
      source: 'eodhd',
      isValidation,
    });
    logger.warn(
      { inputCode: INPUT_CODE, staleTradingDays: clean.staleTradingDays, isValidation },
      'Compass: VIX stale beyond limit — YELLOW + flagged',
    );
    return;
  }

  const cleanToday = clean.series[clean.series.length - 1].value;
  const fiveDayAvg = smaFromClean(clean.series, AVG_LOOKBACK_OBS);

  if (fiveDayAvg === null) {
    throw new Error(
      `VIX_5D_AVG: insufficient clean history (got ${clean.series.length}, need ${AVG_LOOKBACK_OBS})`,
    );
  }

  const colorBand = evaluateVix(fiveDayAvg, config);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: cleanToday,
    derivedValue: fiveDayAvg,
    colorBand,
    subChecks: {
      closes: clean.series.slice(-5).map((o) => o.value),
      lastDate: windowed[windowed.length - 1].date,
      stale: false,
    },
    source: 'eodhd',
    isValidation,
  });

  logger.info(
    { inputCode: INPUT_CODE, todayClose: cleanToday, fiveDayAvg, colorBand, isValidation },
    'Compass: VIX input ingested',
  );
}


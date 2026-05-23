import { logger } from '@core/utils/logger';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { compute30DayChange } from '../compass-calculations';
import { evaluate2s10s } from '../compass-bands';
import { addDays } from './_input-helpers';

const INPUT_CODE = 'YIELD_2S10S';
const DAYS_BACK = 50;

export async function ingestYieldCurveInput(
  observationDate: Date,
  isValidation: boolean = false,
): Promise<void> {
  const obs = isValidation
    ? await compassFredClient.fetchSeriesByDateRange(
        compassFredClient.SERIES.YIELD_2S10S,
        addDays(observationDate, -DAYS_BACK),
        observationDate,
      )
    : await compassFredClient.fetchSeries(
        compassFredClient.SERIES.YIELD_2S10S,
        DAYS_BACK,
      );

  const windowed = isValidation
    ? obs.filter((o) => o.date.getTime() <= observationDate.getTime())
    : obs;

  const values = windowed
    .map((o) => o.value)
    .filter((v): v is number => v !== null);

  if (values.length === 0) {
    throw new Error('YIELD_2S10S: FRED returned zero usable values');
  }

  const todayLevel = values[values.length - 1];
  const thirtyDayChange = compute30DayChange(values);
  const colorBand = evaluate2s10s(todayLevel, thirtyDayChange);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: todayLevel,
    derivedValue: thirtyDayChange,
    colorBand,
    subChecks: {
      observationCount: values.length,
      seriesId: compassFredClient.SERIES.YIELD_2S10S,
    },
    source: 'fred',
    isValidation,
  });

  logger.info(
    { inputCode: INPUT_CODE, todayLevel, thirtyDayChange, colorBand, isValidation },
    'Compass: 2s10s yield curve input ingested',
  );
}

import { logger } from '@core/utils/logger';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { compute30DayChange } from '../compass-calculations';
import { evaluateHyOas } from '../compass-bands';
import { addDays } from './_input-helpers';

const INPUT_CODE = 'HY_OAS';
const DAYS_BACK = 50;

export async function ingestHyOasInput(
  observationDate: Date,
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

  const values = windowed
    .map((o) => o.value)
    .filter((v): v is number => v !== null);

  if (values.length === 0) {
    throw new Error('HY_OAS: FRED returned zero usable values');
  }

  const todayLevel = values[values.length - 1];
  const thirtyDayChange = compute30DayChange(values);
  const colorBand = evaluateHyOas(todayLevel, thirtyDayChange);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: todayLevel,
    derivedValue: thirtyDayChange,
    colorBand,
    subChecks: {
      observationCount: values.length,
      seriesId: compassFredClient.SERIES.HY_OAS,
    },
    source: 'fred',
    isValidation,
  });

  logger.info(
    { inputCode: INPUT_CODE, todayLevel, thirtyDayChange, colorBand, isValidation },
    'Compass: HY OAS input ingested',
  );
}

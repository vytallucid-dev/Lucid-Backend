import { logger } from '@core/utils/logger';
import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { compute5DayAverage } from '../compass-calculations';
import { evaluateVix } from '../compass-bands';
import { addDays, toIsoDate } from './_input-helpers';

const INPUT_CODE = 'VIX_5D_AVG';
const SYMBOL = 'VIX.INDX';
const DAYS_BACK = 15;

export async function ingestVixInput(
  observationDate: Date,
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

  const closes = windowed.map((p) => p.value);
  const fiveDayAvg = compute5DayAverage(closes);
  const todayClose = closes[closes.length - 1];

  if (fiveDayAvg === null) {
    throw new Error(
      `VIX_5D_AVG: insufficient history (got ${closes.length} closes, need 5)`,
    );
  }

  const colorBand = evaluateVix(fiveDayAvg);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: todayClose,
    derivedValue: fiveDayAvg,
    colorBand,
    subChecks: {
      closes: closes.slice(-5),
      lastDate: windowed[windowed.length - 1].date,
    },
    source: 'eodhd',
    isValidation,
  });

  logger.info(
    { inputCode: INPUT_CODE, todayClose, fiveDayAvg, colorBand, isValidation },
    'Compass: VIX input ingested',
  );
}


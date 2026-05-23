import { logger } from '@core/utils/logger';
import { yahooClient } from '@core/clients/yahoo/yahoo.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { compute5DayAverage } from '../compass-calculations';
import { evaluateVix } from '../compass-bands';
import { addDays } from './_input-helpers';

const INPUT_CODE = 'VIX_5D_AVG';
const SYMBOL = '^VIX';
const DAYS_BACK = 15;

export async function ingestVixInput(
  observationDate: Date,
  isValidation: boolean = false,
): Promise<void> {
  const rows = isValidation
    ? await yahooClient.fetchDailyHistory({
        symbol: SYMBOL,
        periodStart: addDays(observationDate, -DAYS_BACK),
        periodEnd: addDays(observationDate, 1),
      })
    : await yahooClient.fetchDailyHistory({
        symbol: SYMBOL,
        daysBack: DAYS_BACK,
      });

  const windowed = isValidation
    ? rows.filter((r) => r.date.getTime() <= observationDate.getTime())
    : rows;

  if (windowed.length === 0) {
    throw new Error('VIX_5D_AVG: Yahoo returned zero rows');
  }

  const closes = windowed.map((r) => r.close);
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
      lastDate: windowed[windowed.length - 1].date.toISOString().slice(0, 10),
    },
    source: 'yahoo',
    isValidation,
  });

  logger.info(
    { inputCode: INPUT_CODE, todayClose, fiveDayAvg, colorBand, isValidation },
    'Compass: VIX input ingested',
  );
}


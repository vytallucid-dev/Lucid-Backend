import { logger } from '@core/utils/logger';
import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import {
  compute50DaySMA,
  computePctDistance,
  compute5DayPctChange,
} from '../compass-calculations';
import { evaluateDxyTrend } from '../compass-bands';
import { addDays, toIsoDate } from './_input-helpers';

const INPUT_CODE = 'DXY_TREND';
const SYMBOL = 'DXY.INDX';
const DAYS_BACK = 90;

export async function ingestDxyTrendInput(
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

  const closes = windowed.map((p) => p.value);
  if (closes.length === 0) {
    throw new Error('DXY_TREND: EODHD returned zero rows');
  }

  const todayClose = closes[closes.length - 1];
  const sma50 = compute50DaySMA(closes);
  const fiveDayPctChange = compute5DayPctChange(closes);

  if (sma50 === null || fiveDayPctChange === null) {
    throw new Error(
      `DXY_TREND: insufficient history (got ${closes.length}, need 50 + 6)`,
    );
  }

  const pctDistance = computePctDistance(todayClose, sma50);
  const colorBand = evaluateDxyTrend(pctDistance, fiveDayPctChange);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: todayClose,
    derivedValue: pctDistance,
    colorBand,
    subChecks: {
      sma50,
      fiveDayPctChange,
      symbol: SYMBOL,
    },
    source: 'eodhd',
    isValidation,
  });

  logger.info(
    {
      inputCode: INPUT_CODE,
      todayClose,
      sma50,
      pctDistance,
      fiveDayPctChange,
      colorBand,
      isValidation,
    },
    'Compass: DXY trend input ingested',
  );
}

import { logger } from '@core/utils/logger';
import { yahooClient } from '@core/clients/yahoo/yahoo.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import {
  compute50DaySMA,
  computePctDistance,
  compute5DayPctChange,
} from '../compass-calculations';
import { evaluateDxyTrend } from '../compass-bands';
import { addDays } from './_input-helpers';

const INPUT_CODE = 'DXY_TREND';
const SYMBOL = 'DX-Y.NYB';
const DAYS_BACK = 90;

export async function ingestDxyTrendInput(
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

  const closes = windowed.map((r) => r.close);
  if (closes.length === 0) {
    throw new Error('DXY_TREND: Yahoo returned zero rows');
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
    source: 'yahoo',
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

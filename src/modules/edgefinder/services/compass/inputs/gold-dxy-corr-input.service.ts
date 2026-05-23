import { logger } from '@core/utils/logger';
import { yahooClient } from '@core/clients/yahoo/yahoo.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import {
  alignByDate,
  computePearsonCorrelation,
} from '../compass-calculations';
import { evaluateGoldDxyCorrelation } from '../compass-bands';
import { addDays } from './_input-helpers';

const INPUT_CODE = 'GOLD_DXY_CORR';
const ROLLING_WINDOW = 60;
const DAYS_BACK = 100;

export async function ingestGoldDxyCorrInput(
  observationDate: Date,
  isValidation: boolean = false,
): Promise<void> {
  const periodStart = addDays(observationDate, -DAYS_BACK);
  const periodEnd = addDays(observationDate, 1);

  const [goldRows, dxyRows] = await Promise.all([
    isValidation
      ? yahooClient.fetchDailyHistory({ symbol: 'GC=F', periodStart, periodEnd })
      : yahooClient.fetchDailyHistory({ symbol: 'GC=F', daysBack: DAYS_BACK }),
    isValidation
      ? yahooClient.fetchDailyHistory({ symbol: 'DX-Y.NYB', periodStart, periodEnd })
      : yahooClient.fetchDailyHistory({ symbol: 'DX-Y.NYB', daysBack: DAYS_BACK }),
  ]);

  const goldFiltered = isValidation
    ? goldRows.filter((r) => r.date.getTime() <= observationDate.getTime())
    : goldRows;
  const dxyFiltered = isValidation
    ? dxyRows.filter((r) => r.date.getTime() <= observationDate.getTime())
    : dxyRows;

  const goldSeries = goldFiltered.map((r) => ({ date: r.date, value: r.close }));
  const dxySeries = dxyFiltered.map((r) => ({ date: r.date, value: r.close }));

  const aligned = alignByDate(goldSeries, dxySeries);

  if (aligned.xs.length < ROLLING_WINDOW) {
    throw new Error(
      `GOLD_DXY_CORR: insufficient aligned history (got ${aligned.xs.length}, need ${ROLLING_WINDOW})`,
    );
  }

  const xWindow = aligned.xs.slice(-ROLLING_WINDOW);
  const yWindow = aligned.ys.slice(-ROLLING_WINDOW);
  const correlation = computePearsonCorrelation(xWindow, yWindow);

  if (correlation === null) {
    throw new Error('GOLD_DXY_CORR: correlation undefined (zero variance)');
  }

  const colorBand = evaluateGoldDxyCorrelation(correlation);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: correlation,
    derivedValue: correlation,
    colorBand,
    subChecks: {
      windowDays: ROLLING_WINDOW,
      alignedRowCount: aligned.xs.length,
      symbols: { gold: 'GC=F', dxy: 'DX-Y.NYB' },
    },
    source: 'derived',
    isValidation,
  });

  logger.info(
    {
      inputCode: INPUT_CODE,
      correlation,
      colorBand,
      alignedRowCount: aligned.xs.length,
      isValidation,
    },
    'Compass: Gold/DXY correlation input ingested',
  );
}
